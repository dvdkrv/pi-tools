import { connect, type NatsConnection, type Subscription } from '@nats-io/transport-node';
import { AckPolicy, DeliverPolicy, DiscardPolicy, ReplayPolicy, RetentionPolicy, StorageType, JetStreamApiError, jetstream, jetstreamManager, type Consumer, type JetStreamClient, type JetStreamManager } from '@nats-io/jetstream';
import { Kvm, KvWatchInclude, type KV, type KvWatchEntry } from '@nats-io/kv';
import { setTimeout as delay } from 'node:timers/promises';
import { MessagingError, type BrokerConfig, type Envelope, type GroupRef, type GroupSummary, type MessagingBackend, type MessageStatus, type ParticipantLease, type Peer, type Reservation, type Route, type SendInput } from './contracts.ts';
import * as policy from './policy.ts';

const STREAM = 'PM_MESSAGES';
const BUCKET = 'PM_CONTROL';
const CHANGED = 'pm.changed';
const subject = (m: MessageStatus) => `pm.message.${m.groupId}.${m.recipientPeerId}.${m.id}`;
const consumerName = (peerId: string) => `peer_${peerId.replaceAll('-', '')}`;
const presenceKey = (peerId: string) => `presence.${peerId}`;
const peerIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
interface Presence { version: 1; peerId: string; leaseId: string; lastSeen: number }
const apiCode = (error: unknown, code: number) => error instanceof JetStreamApiError && error.code === code;

/** Provisioning is only called by explicit broker bootstrap, never by a Pi tool. */
export async function connectBackend(config: BrokerConfig, options: { initialize?: boolean; timeoutMs?: number } = {}): Promise<MessagingBackend> {
  const timeoutMs = options.timeoutMs ?? 1500;
  const nc = await connect({ servers: config.server, token: config.token, reconnect: false, timeout: timeoutMs, name: 'pi-messaging' });
  try {
    const js = jetstream(nc, { timeout: timeoutMs });
    const jsm = await jetstreamManager(nc, { timeout: timeoutMs });
    const kvm = new Kvm(js);
    let initializeEmpty = false;
    if (options.initialize) {
      const streamExists = async (name: string): Promise<boolean> => {
        try { await jsm.streams.info(name); return true; }
        catch (error) { if (apiCode(error, 10059)) return false; throw error; }
      };
      const messagesExist = await streamExists(STREAM);
      const bucketExists = await streamExists(`KV_${BUCKET}`);
      if (messagesExist !== bucketExists) policy.fail('configuration', 'Unsafe or incompatible partial broker stream state');
      initializeEmpty = !messagesExist;
      if (initializeEmpty) {
        await jsm.streams.add({ name: STREAM, subjects: ['pm.message.>'], storage: StorageType.File, retention: RetentionPolicy.Limits, discard: DiscardPolicy.New, max_msgs: 2000, max_bytes: 32 * 1024 * 1024, max_msg_size: 65536, max_age: 0, max_consumers: 512 });
      }
    }
    const kv = initializeEmpty
      ? await kvm.create(BUCKET, { history: 1, storage: StorageType.File, maxValueSize: 2 * 1024 * 1024, max_bytes: 8 * 1024 * 1024 })
      : await kvm.open(BUCKET);
    if (initializeEmpty) await kv.create('state', JSON.stringify(policy.newLedger(config.authorityId)));
    const stateEntry = await kv.get('state');
    if (!stateEntry || stateEntry.operation !== 'PUT') policy.fail('missing', 'Messaging ledger missing; refusing to recreate allowance');
    let stored: unknown;
    try { stored = JSON.parse(stateEntry.string()); }
    catch { policy.fail('corrupt', 'Unsupported or corrupt messaging ledger'); }
    const migration = policy.migrateLedger(stored, config.authorityId);
    if (migration.migrated) {
      const next = JSON.stringify(migration.ledger);
      if (Buffer.byteLength(next) > 2 * 1024 * 1024) policy.fail('full', 'Messaging control ledger full; prune terminal history');
      try { await kv.update('state', next, stateEntry.revision); }
      catch (error) {
        if (!apiCode(error, 10071)) throw new MessagingError('uncertain', 'Messaging ledger migration outcome uncertain; close and inspect before reconnecting');
        const winner = await kv.get('state');
        if (!winner || winner.operation !== 'PUT') policy.fail('missing', 'Messaging ledger missing after concurrent migration');
        let value: unknown;
        try { value = JSON.parse(winner.string()); }
        catch { policy.fail('corrupt', 'Unsupported or corrupt messaging ledger'); }
        policy.validateLedger(value, config.authorityId);
      }
    }
    const stream = (await jsm.streams.info(STREAM)).config;
    const bucket = (await jsm.streams.info(`KV_${BUCKET}`)).config;
    if (stream.storage !== StorageType.File || stream.retention !== RetentionPolicy.Limits || stream.discard !== DiscardPolicy.New || stream.max_age !== 0 || stream.max_msgs !== 2000 || stream.max_bytes !== 32 * 1024 * 1024 || stream.max_msg_size !== 65536 || stream.max_consumers !== 512 || stream.subjects?.join() !== 'pm.message.>' || bucket.storage !== StorageType.File || bucket.max_age !== 0 || bucket.max_msgs_per_subject !== 1 || bucket.max_bytes !== 8 * 1024 * 1024 || bucket.max_msg_size !== 2 * 1024 * 1024) policy.fail('configuration', 'Unsafe or incompatible broker stream configuration');
    const backend = new NatsBackend(nc, js, jsm, kv, config.authorityId);
    await backend.initializePresence(); await backend.snapshot();
    return backend;
  } catch (error) { await nc.close(); throw error; }
}

class NatsBackend implements MessagingBackend {
  private nc: NatsConnection;
  private js: JetStreamClient;
  private jsm: JetStreamManager;
  private kv: KV;
  private authorityId: string;
  private participant?: { peer: Peer; lease: ParticipantLease };
  private consumer?: Consumer;
  private failed = false;
  private fetching = false;
  private joining = false;
  private membershipDone?: Promise<void>;
  private membershipGeneration = 0;
  private lastMaintenance = 0;
  private subscriptions = new Set<Subscription>();
  private presence = new Map<string, { revision: number; value?: Presence }>();
  private presenceWatch?: Awaited<ReturnType<KV['watch']>>;
  private presenceTask?: Promise<void>;
  private stopping = false;
  constructor(nc: NatsConnection, js: JetStreamClient, jsm: JetStreamManager, kv: KV, authorityId: string) {
    this.nc = nc; this.js = js; this.jsm = jsm; this.kv = kv; this.authorityId = authorityId;
  }
  get peer(): Peer | undefined { return this.participant ? { ...this.participant.peer } : undefined; }
  get lease(): ParticipantLease | undefined { return this.participant ? { ...this.participant.lease } : undefined; }
  get closed(): boolean { return this.failed || this.nc.isClosed(); }
  private async io<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) policy.fail('unavailable', 'Messaging broker unavailable; messaging reconnects automatically');
    try { return await operation(); }
    catch (error) {
      this.failed = true;
      throw new MessagingError('uncertain', `Broker operation failed or has an uncertain outcome; it was not retried, and messaging reconnects automatically. ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
  async initializePresence(): Promise<void> {
    const watch = await this.io(() => this.kv.watch({ key: 'presence.>', include: KvWatchInclude.UpdatesOnly })); this.presenceWatch = watch;
    this.presenceTask = (async () => {
      try { for await (const entry of watch) this.mergePresence(entry); if (!this.stopping) this.failed = true; }
      catch { if (!this.stopping) this.failed = true; }
    })();
    await this.io(async () => {
      for await (const key of await this.kv.keys('presence.>')) { const entry = await this.kv.get(key); if (entry) this.mergePresence(entry); }
    });
  }
  private mergePresence(entry: KvWatchEntry | NonNullable<Awaited<ReturnType<KV['get']>>>): void {
    if (!entry.key.startsWith('presence.')) return;
    const peerId = entry.key.slice('presence.'.length); const current = this.presence.get(peerId);
    if (current && current.revision >= entry.revision) return;
    let value: Presence | undefined;
    if (entry.operation === 'PUT') try {
      const candidate: unknown = entry.json();
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
        const item = candidate as Record<string, unknown>;
        if (item.version === 1 && item.peerId === peerId && peerIdPattern.test(peerId) && typeof item.leaseId === 'string' && peerIdPattern.test(item.leaseId) && typeof item.lastSeen === 'number' && Number.isFinite(item.lastSeen)) value = { version: 1, peerId, leaseId: item.leaseId, lastSeen: item.lastSeen };
      }
    } catch {}
    this.presence.set(peerId, { revision: entry.revision, ...(value ? { value } : {}) });
  }
  private async rawSnapshot(): Promise<{ state: policy.Ledger; revision: number }> {
    const entry = await this.io(() => this.kv.get('state'));
    if (!entry || entry.operation !== 'PUT') { this.failed = true; policy.fail('missing', 'Messaging ledger missing; refusing to recreate allowance'); }
    try {
      const state: unknown = JSON.parse(entry.string()); policy.validateLedger(state, this.authorityId);
      return { state, revision: entry.revision };
    } catch (error) { this.failed = true; throw error; }
  }
  async snapshot(): Promise<{ state: policy.Ledger; revision: number }> {
    const snapshot = await this.rawSnapshot();
    for (const peer of Object.values(snapshot.state.peers)) {
      const presence = this.presence.get(peer.id)?.value;
      if (peer.active && !peer.suspended && presence?.leaseId === peer.leaseId) peer.lastSeen = Math.max(peer.lastSeen, presence.lastSeen);
    }
    return snapshot;
  }
  private notify(): void { if (!this.nc.isClosed()) this.nc.publish(CHANGED); }
  private async change<T>(mutate: (state: policy.Ledger) => T, uncertain?: (result: T) => MessagingError): Promise<T> {
    for (let retry = 0; retry < 64; retry++) {
      const { state, revision } = await this.snapshot();
      const original = JSON.stringify(state);
      const result = mutate(state);
      const next = JSON.stringify(state);
      if (next === original) return result;
      if (Buffer.byteLength(next) > 2 * 1024 * 1024) policy.fail('full', 'Messaging control ledger full; prune terminal history');
      try { await this.kv.update('state', next, revision); this.notify(); return result; }
      catch (error) {
        // Only the server's explicit wrong-revision response establishes no commit.
        if (apiCode(error, 10071)) { await delay(Math.min(50, retry * 2) + Math.random() * 10); continue; }
        this.failed = true;
        throw uncertain?.(result) ?? new MessagingError('uncertain', 'Ledger write outcome uncertain; it was not retried, and messaging reconnects automatically');
      }
    }
    policy.fail('busy', 'Messaging ledger busy; operation was not committed');
  }
  async listGroups(): Promise<GroupRef[]> { return Object.values((await this.snapshot()).state.groups).map(policy.refOf); }
  async createGroup(label: string, options?: { auto?: boolean; routeCooldownMs?: number }): Promise<GroupRef> { return this.change(s => policy.createGroup(s, label, options)); }
  async getGroupSummary(ref: GroupRef): Promise<GroupSummary | null> {
    const { state } = await this.snapshot();
    if (ref.authorityId !== state.authorityId) policy.fail('authority', 'Messaging authority mismatch');
    return Object.hasOwn(state.groups, ref.id) ? policy.summary(state, ref) : null;
  }
  async peers(ref: GroupRef): Promise<Peer[]> {
    const { state } = await this.snapshot(); policy.groupOf(state, ref);
    return Object.values(state.peers).filter(peer => peer.groupId === ref.id).map(policy.publicPeer);
  }
  async routes(ref: GroupRef): Promise<Route[]> {
    const { state } = await this.snapshot(); policy.groupOf(state, ref);
    return Object.values(state.routes).filter(route => route.groupId === ref.id).map(route => ({ ...route }));
  }
  async setRoute(ref: GroupRef, fromPeerId: string, toPeerId: string, mode: 'open' | 'closed', recoverReplyOnly = false): Promise<void> {
    await this.change(state => policy.setRoute(state, ref, fromPeerId, toPeerId, mode, recoverReplyOnly));
  }
  private async bindConsumer(peerId: string, groupId: string): Promise<{ consumer: Consumer; created: boolean }> {
    const name = consumerName(peerId);
    const expected = {
      durable_name: name, filter_subject: `pm.message.${groupId}.${peerId}.*`, ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.All, replay_policy: ReplayPolicy.Instant, max_ack_pending: 8,
      ack_wait: 5_000_000_000, max_deliver: -1, max_waiting: 512, num_replicas: 0,
    };
    let created = false;
    const info = await this.io(async () => {
      try { return await this.jsm.consumers.info(STREAM, name); }
      catch (error) {
        if (!apiCode(error, 10014)) throw error;
        const added = await this.jsm.consumers.add(STREAM, expected); created = true; return added;
      }
    });
    const config = info.config;
    const hasUnexpectedBehavior = config.deliver_subject !== undefined || config.deliver_group !== undefined
      || config.flow_control === true || (config.idle_heartbeat ?? 0) !== 0 || config.headers_only === true
      || (config.inactive_threshold ?? 0) !== 0 || (config.backoff?.length ?? 0) !== 0
      || config.pause_until !== undefined || info.paused === true || (config.opt_start_seq ?? 0) !== 0
      || config.opt_start_time !== undefined || (config.rate_limit_bps ?? 0) !== 0
      || (config.max_batch ?? 0) !== 0 || (config.max_expires ?? 0) !== 0 || (config.max_bytes ?? 0) !== 0
      || config.mem_storage === true || (config.filter_subjects?.length ?? 0) !== 0
      || config.priority_policy !== undefined || (config.priority_groups?.length ?? 0) !== 0
      || (config.priority_timeout ?? 0) !== 0;
    if (info.stream_name !== STREAM || config.name !== name || config.durable_name !== expected.durable_name
      || config.filter_subject !== expected.filter_subject || config.ack_policy !== expected.ack_policy
      || config.deliver_policy !== expected.deliver_policy || config.replay_policy !== expected.replay_policy
      || config.max_ack_pending !== expected.max_ack_pending || config.ack_wait !== expected.ack_wait
      || config.max_deliver !== expected.max_deliver || config.max_waiting !== expected.max_waiting
      || config.num_replicas !== expected.num_replicas || hasUnexpectedBehavior) {
      policy.fail('configuration', 'Unsafe or incompatible peer consumer configuration');
    }
    return { consumer: await this.io(() => this.js.consumers.get(STREAM, name)), created };
  }
  async join(ref: GroupRef, info: { sessionId: string; displayName: string }): Promise<Peer> {
    if (this.participant || this.joining) policy.fail('participation', 'Leave the current group before joining');
    this.joining = true;
    let settle!: () => void;
    const done = new Promise<void>(resolve => { settle = resolve; }); this.membershipDone = done;
    const generation = ++this.membershipGeneration;
    try {
      const stored = await this.change(s => policy.joinPeer(s, ref, info));
      const participation = { peer: policy.publicPeer(stored), lease: policy.leaseOf(stored) };
      if (generation !== this.membershipGeneration) {
        await this.change(s => policy.leavePeer(s, participation.lease));
        await this.deleteConsumer(consumerName(participation.peer.id));
        policy.fail('participation', 'Join canceled by session departure');
      }
      let binding: { consumer: Consumer; created: boolean };
      try { binding = await this.bindConsumer(participation.peer.id, ref.id); }
      catch (error) {
        if (!this.closed && error instanceof MessagingError && error.code !== 'uncertain') {
          await this.change(s => policy.leavePeer(s, participation.lease));
        }
        throw error;
      }
      if (generation !== this.membershipGeneration) {
        await this.change(s => policy.leavePeer(s, participation.lease));
        await this.deleteConsumer(consumerName(participation.peer.id));
        policy.fail('participation', 'Join canceled by session departure');
      }
      this.participant = participation; this.consumer = binding.consumer;
      return { ...participation.peer };
    } finally { this.joining = false; settle(); if (this.membershipDone === done) this.membershipDone = undefined; }
  }
  async resume(ref: GroupRef, peerId: string, sessionId: string): Promise<Peer> {
    if (this.participant || this.joining) policy.fail('participation', 'Leave the current group before resuming');
    this.joining = true;
    let settle!: () => void;
    const done = new Promise<void>(resolve => { settle = resolve; }); this.membershipDone = done;
    const generation = ++this.membershipGeneration;
    try {
      const preflight = (await this.snapshot()).state;
      policy.resumePeer(structuredClone(preflight), ref, sessionId, peerId);
      const binding = await this.bindConsumer(peerId, ref.id);
      if (generation !== this.membershipGeneration) policy.fail('participation', 'Resume canceled by session departure');
      let stored: ReturnType<typeof policy.resumePeer>;
      try { stored = await this.change(state => policy.resumePeer(state, ref, sessionId, peerId)); }
      catch (error) {
        if (binding.created && !this.closed && error instanceof MessagingError && error.code !== 'uncertain') {
          const current = (await this.snapshot()).state;
          const peer = Object.hasOwn(current.peers, peerId) ? current.peers[peerId] : undefined;
          if (!peer || !peer.active || peer.groupId !== ref.id) await this.deleteConsumer(consumerName(peerId));
        }
        throw error;
      }
      const participation = { peer: policy.publicPeer(stored), lease: policy.leaseOf(stored) };
      if (generation !== this.membershipGeneration) {
        await this.change(state => policy.suspendPeer(state, participation.lease));
        policy.fail('participation', 'Resume canceled by session departure');
      }
      this.participant = participation; this.consumer = binding.consumer;
      return { ...participation.peer };
    } finally { this.joining = false; settle(); if (this.membershipDone === done) this.membershipDone = undefined; }
  }
  async takeover(ref: GroupRef, peerId: string, sessionId: string): Promise<Peer> {
    if (this.participant || this.joining) policy.fail('participation', 'Leave the current group before takeover');
    this.joining = true;
    let settle!: () => void;
    const done = new Promise<void>(resolve => { settle = resolve; }); this.membershipDone = done;
    const generation = ++this.membershipGeneration;
    try {
      const preflight = (await this.snapshot()).state;
      policy.takeoverPeer(structuredClone(preflight), ref, sessionId, peerId);
      const binding = await this.bindConsumer(peerId, ref.id);
      if (generation !== this.membershipGeneration) policy.fail('participation', 'Takeover canceled by session departure');
      let stored: ReturnType<typeof policy.takeoverPeer>;
      try { stored = await this.change(state => policy.takeoverPeer(state, ref, sessionId, peerId)); }
      catch (error) {
        if (binding.created && !this.closed && error instanceof MessagingError && error.code !== 'uncertain') {
          const current = (await this.snapshot()).state; const peer = current.peers[peerId];
          if (!peer?.active || peer.groupId !== ref.id) await this.deleteConsumer(consumerName(peerId));
        }
        throw error;
      }
      const participation = { peer: policy.publicPeer(stored), lease: policy.leaseOf(stored) };
      if (generation !== this.membershipGeneration) {
        await this.change(state => policy.suspendPeer(state, participation.lease));
        policy.fail('participation', 'Takeover canceled by session departure');
      }
      this.participant = participation; this.consumer = binding.consumer;
      return { ...participation.peer };
    } finally { this.joining = false; settle(); if (this.membershipDone === done) this.membershipDone = undefined; }
  }
  async reattach(ref: GroupRef, lease: ParticipantLease): Promise<Peer> {
    if (this.participant || this.joining) policy.fail('participation', 'Leave the current group before reattaching');
    this.joining = true;
    let settle!: () => void;
    const done = new Promise<void>(resolve => { settle = resolve; }); this.membershipDone = done;
    const generation = ++this.membershipGeneration;
    try {
      // Reattach never writes the ledger: the lease must still be current, which fences
      // any takeover, suspension, revocation, or expiry that happened while disconnected.
      const { state } = await this.snapshot(); policy.groupOf(state, ref);
      const stored = policy.requireLease(state, lease);
      if (stored.groupId !== ref.id) policy.fail('participation', 'Peer does not belong to this group');
      const binding = await this.bindConsumer(stored.id, ref.id);
      if (generation !== this.membershipGeneration) policy.fail('participation', 'Reattach canceled by session departure');
      const seenAt = Date.now(); await this.putPresence(stored, seenAt);
      if (generation !== this.membershipGeneration) { await this.purgePresence(stored.id); policy.fail('participation', 'Reattach canceled by session departure'); }
      const peer = { ...policy.publicPeer(stored), lastSeen: Math.max(stored.lastSeen, seenAt) };
      this.participant = { peer, lease: { peerId: stored.id, leaseId: stored.leaseId } }; this.consumer = binding.consumer;
      return { ...peer };
    } finally { this.joining = false; settle(); if (this.membershipDone === done) this.membershipDone = undefined; }
  }
  async suspend(): Promise<void> {
    this.membershipGeneration++;
    const participation = this.participant; this.participant = undefined; this.consumer = undefined;
    if (!participation || this.closed) return;
    await this.change(state => policy.suspendPeer(state, participation.lease));
  }
  async leave(): Promise<void> {
    this.membershipGeneration++;
    const participation = this.participant; this.participant = undefined; this.consumer = undefined;
    if (!participation || this.closed) return;
    await this.change(state => policy.leavePeer(state, participation.lease));
    await this.purgePresence(participation.peer.id); await this.deleteConsumer(consumerName(participation.peer.id));
  }
  private async purgePresence(peerId: string): Promise<void> {
    try { await this.jsm.streams.purge(`KV_${BUCKET}`, { filter: `$KV.${BUCKET}.${presenceKey(peerId)}` }); } catch {}
  }
  private async deleteConsumer(name: string): Promise<void> {
    await this.io(async () => {
      try { await this.jsm.consumers.delete(STREAM, name); }
      catch (error) { if (!apiCode(error, 10014)) throw error; }
    });
  }
  private joined(): { peer: Peer; lease: ParticipantLease } { if (!this.participant) policy.fail('participation', 'Explicitly join a messaging group first'); return this.participant; }
  private async putPresence(peer: { id: string; leaseId: string }, lastSeen: number): Promise<void> {
    await this.io(() => this.kv.put(presenceKey(peer.id), JSON.stringify({ version: 1, peerId: peer.id, leaseId: peer.leaseId, lastSeen })));
  }
  async heartbeat(displayName?: string): Promise<void> {
    const participation = this.joined(); const { state } = await this.rawSnapshot();
    const stored = policy.requireLease(state, participation.lease); const now = Date.now();
    const nextName = displayName === undefined ? stored.displayName : policy.validateDisplayName(displayName);
    await this.putPresence(stored, now);
    if (nextName !== stored.displayName || now - stored.lastSeen >= policy.LEDGER_REFRESH_MS) {
      participation.peer = await this.change(ledger => {
        policy.heartbeat(ledger, participation.lease, nextName, now + 1);
        return policy.publicPeer(policy.requireLease(ledger, participation.lease));
      });
    } else participation.peer = { ...participation.peer, lastSeen: Math.max(participation.peer.lastSeen, stored.lastSeen, now) };
  }
  async arm(ref: GroupRef, limit: number): Promise<void> { await this.change(s => policy.arm(s, ref, limit)); }
  async pause(ref: GroupRef): Promise<void> { await this.change(s => policy.pause(s, ref)); }
  async maintain(ref: GroupRef, now = Date.now(), options?: { routeCooldownMs?: number }): Promise<void> {
    await this.change(state => { policy.groupOf(state, ref); policy.maintain(state, now, options); });
    if (now - this.lastMaintenance >= 60_000) {
      await this.prune(ref, true, now - policy.HISTORY_TTL_MS); this.lastMaintenance = now;
    }
  }
  async send(input: SendInput, requestKey: string, options?: { sendsPerHour?: number }): Promise<MessageStatus> {
    const participation = this.joined(); const { peer, lease } = participation; policy.validateInput(input);
    if (Date.now() - this.lastMaintenance > 60000) {
      const { state } = await this.snapshot();
      policy.requireLease(state, lease);
      await this.prune(policy.refOf(state.groups[peer.groupId]), true, Date.now() - 7 * 86400000);
      this.lastMaintenance = Date.now();
    }
    const committed = await this.change(state => {
      policy.maintain(state); const message = policy.prepareMessage(state, lease, input, requestKey, Date.now(), options);
      return { message, peer: policy.publicPeer(policy.requireLease(state, lease)) };
    }, result => new MessagingError('uncertain', 'Message metadata write outcome uncertain; recorded as uncertain and not resent. Do not assume resending is safe.', { uncertainMessage: result.message }));
    participation.peer = committed.peer; const m = committed.message;
    // An idempotent retry of an attempted/terminal message must not republish it.
    if (m.state !== 'queued') return m;
    const body = policy.envelope(policy.newLedger(this.authorityId), m, input.text);
    try { await this.js.publish(subject(m), JSON.stringify(body), { expect: { lastSubjectSequence: 0 } }); }
    catch (error) {
      if (apiCode(error, 10071)) {
        let stored;
        try { stored = await this.io(() => this.jsm.streams.getMessage(STREAM, { last_by_subj: subject(m) })); }
        catch (failure) { throw failure instanceof MessagingError && failure.code === 'uncertain' ? new MessagingError('uncertain', failure.message, { uncertainMessage: m }) : failure; }
        if (!stored) { this.failed = true; throw new MessagingError('uncertain', 'Conflicting publication disappeared; inspect messaging state', { uncertainMessage: m }); }
        policy.validateEnvelope(stored.json<Envelope>(), policy.newLedger(this.authorityId), m);
      } else { this.failed = true; throw new MessagingError('uncertain', 'Message publication uncertain; metadata retained and not resent. Do not assume resending is safe.', { uncertainMessage: m }); }
    }
    this.notify(); return m;
  }
  async reserve(): Promise<Reservation[]> {
    const participation = this.joined(); const { peer, lease } = participation; const consumer = this.consumer;
    if (!consumer || this.fetching) return [];
    this.fetching = true;
    try {
      // Capture the body-publication boundary before reading ledger candidates. A sender
      // commits metadata first, so a body with a later stream sequence waits for the
      // next idle batch even if its queued metadata is already visible here.
      const boundary = (await this.io(() => this.jsm.streams.info(STREAM))).state.last_seq;
      const { state } = await this.snapshot();
      if (!policy.canReceive(state, lease)) return [];
      const candidateIds = new Set(Object.values(state.messages)
        .filter(message => message.recipientPeerId === peer.id && message.state === 'queued')
        .map(message => message.id));
      const target = Math.min(policy.MAX_QUEUED_PER_RECIPIENT, candidateIds.size);
      const held: Array<{ message: { ack(): void; nak(millis?: number): void }; body: Envelope }> = [];
      const deadline = Date.now() + 1000;
      let drained = 0; let stop = false;
      while (drained < 64 && !stop && Date.now() < deadline && (target === 0 ? drained === 0 : held.length < target)) {
        const requested = target === 0 ? 1 : Math.min(target - held.length, 8);
        let received = 0;
        await this.io(async () => {
          const messages = await consumer.fetch({ max_messages: requested, expires: 1000 });
          try {
            for await (const message of messages) {
              received++; drained++;
              if (message.seq > boundary) { message.nak(1000); stop = true; break; }
              const body = message.json<Envelope>();
              const metadata = Object.hasOwn(state.messages, body.messageId) ? state.messages[body.messageId] : undefined;
              // Before the captured stream boundary, absent metadata denotes stale
              // transport residue, not a newly published message. It cannot be admitted.
              if (!metadata) { message.ack(); continue; }
              policy.validateEnvelope(body, state, metadata);
              if (metadata.recipientPeerId !== peer.id) policy.fail('corrupt', 'Consumer returned another peer inbox');
              if (metadata.state !== 'queued') { message.ack(); continue; }
              if (!candidateIds.has(metadata.id)) { message.nak(1000); stop = true; break; }
              held.push({ message, body });
            }
          } finally { await messages.close(); }
        });
        if (target === 0 || received === 0) break;
      }
      if (held.length === 0) return [];
      const reservations = await this.change(ledger => policy.admitBatch(ledger, lease, held.map(item => item.body.messageId)));
      const admitted = new Set(reservations.map(reservation => reservation.message.id));
      for (const item of held) {
        if (admitted.has(item.body.messageId)) item.message.ack();
        else item.message.nak(1000);
      }
      const bodies = new Map(held.map(item => [item.body.messageId, item.body]));
      return reservations.map(reservation => ({ ...reservation, envelope: bodies.get(reservation.message.id) }));
    } finally { this.fetching = false; }
  }
  async observe(reservations: readonly Reservation[]): Promise<void> {
    const { peer, lease } = this.joined();
    if (reservations.some(reservation => reservation.peerId !== peer.id)) policy.fail('receipt', 'Receipt is not from this participation');
    await this.change(state => policy.observeBatch(state, lease, reservations));
  }
  async listMessages(ref: GroupRef): Promise<MessageStatus[]> {
    const { state } = await this.snapshot(); policy.groupOf(state, ref);
    return Object.values(state.messages).filter(m => m.groupId === ref.id).sort((a, b) => b.sequence - a.sequence);
  }
  async readBody(ref: GroupRef, id: string): Promise<Envelope | null> {
    const { state } = await this.snapshot(); policy.groupOf(state, ref);
    const m = Object.hasOwn(state.messages, id) ? state.messages[id] : undefined;
    if (!m || m.groupId !== ref.id) policy.fail('missing', 'Message does not exist in this group');
    try { const stored = await this.jsm.streams.getMessage(STREAM, { last_by_subj: subject(m) }); if (!stored) return null; const body = stored.json<Envelope>(); policy.validateEnvelope(body, state, m); return body; }
    catch (error) { if (apiCode(error, 10037)) return null; throw error; }
  }
  async resolveMessage(ref: GroupRef, id: string, state: 'canceled' | 'dismissed'): Promise<void> { await this.change(s => policy.resolveMessage(s, ref, id, state)); }
  async revoke(ref: GroupRef, id: string): Promise<void> {
    await this.change(state => policy.revokePeer(state, ref, id));
    await this.purgePresence(id); await this.deleteConsumer(consumerName(id));
  }
  async prune(ref: GroupRef, execute = false, before = Date.now() - policy.HISTORY_TTL_MS): Promise<string[]> {
    const { state } = await this.snapshot(); const ids = policy.prunable(state, ref, before);
    if (!execute) return ids;
    for (const id of ids) await this.io(() => this.jsm.streams.purge(STREAM, { filter: subject(state.messages[id]) }));
    const consumers = await this.io(async () => {
      const names: string[] = [];
      for await (const info of this.jsm.consumers.list(STREAM)) if (/^peer_[0-9a-f]{32}$/.test(info.name)) names.push(info.name);
      return names;
    });
    // Read AFTER enumeration: a newly joined peer's ledger entry precedes its consumer.
    // Inactive identities never become active again; stale-but-active peers need human revocation.
    const current = (await this.snapshot()).state;
    const active = new Set(Object.values(current.peers).filter(p => p.active).map(p => consumerName(p.id)));
    for (const name of consumers) if (!active.has(name)) await this.deleteConsumer(name);
    for (const id of this.presence.keys()) if (!current.peers[id]?.active) await this.purgePresence(id);
    await this.change(s => {
      if (!Object.hasOwn(s.groups, ref.id)) return;
      for (const id of policy.prunable(s, ref, before)) if (ids.includes(id)) delete s.messages[id];
      const usedPeers = new Set(Object.values(s.messages).flatMap(m => [m.senderPeerId, m.recipientPeerId]));
      for (const p of Object.values(s.peers)) if (p.groupId === ref.id && !p.active && !usedPeers.has(p.id)) delete s.peers[p.id];
      if (before === Infinity && !Object.values(s.peers).some(p => p.groupId === ref.id) && !Object.values(s.messages).some(m => m.groupId === ref.id)) delete s.groups[ref.id];
    });
    return ids;
  }
  onChange(callback: () => void): () => void {
    const sub = this.nc.subscribe(CHANGED, { callback: (error) => { if (error) this.failed = true; callback(); } });
    this.subscriptions.add(sub);
    void this.nc.closed().then(() => { if (this.subscriptions.has(sub)) callback(); });
    return () => { this.subscriptions.delete(sub); sub.unsubscribe(); };
  }
  async close(): Promise<void> {
    this.membershipGeneration++; this.stopping = true;
    const pendingMembership = this.membershipDone; if (pendingMembership) await pendingMembership;
    for (const sub of this.subscriptions) sub.unsubscribe(); this.subscriptions.clear();
    this.presenceWatch?.stop(); if (this.presenceTask) await this.presenceTask;
    await this.nc.close();
  }
}
