import { createHash, randomUUID } from 'node:crypto';
import { MessagingError, type Envelope, type Group, type GroupRef, type GroupSummary, type MessageStatus, type ParticipantLease, type Peer, type PeerPresence, type Reservation, type Route, type SendInput, type StoredPeer } from './contracts.ts';

export interface Ledger { version: 3; authorityId: string; sequence: number; groups: Record<string, Group>; peers: Record<string, StoredPeer>; routes: Record<string, Route>; messages: Record<string, MessageStatus> }
interface LegacyPeer { id: string; groupId: string; sessionId: string; displayName: string; active: boolean; lastSeen: number }
interface LegacyLedgerV1 { version: 1; authorityId: string; sequence: number; groups: Record<string, Group>; peers: Record<string, LegacyPeer>; messages: Record<string, Omit<MessageStatus, 'kind'>> }
interface LegacyLedgerV2 { version: 2; authorityId: string; sequence: number; groups: Record<string, Group>; peers: Record<string, StoredPeer>; messages: Record<string, Omit<MessageStatus, 'kind'>> }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const control = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
export const ONLINE_WINDOW_MS = 30_000;
export const MAX_QUEUED_PER_RECIPIENT = 8;
const unresolved = (message: MessageStatus) => message.state === 'queued' || message.state === 'attempted';
const queuedInGroup = (state: Ledger, groupId: string) => Object.values(state.messages).filter(message => message.groupId === groupId && message.state === 'queued');
export function fail(code: string, message: string): never { throw new MessagingError(code, message); }
export function safeText(text: string): string { return text.replace(control, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`); }
export function validateDisplayName(value: string): string {
  if (typeof value !== 'string' || !value.trim() || [...value].length > 64 || safeText(value) !== value || /[\n\r\t]/.test(value)) fail('validation', 'Invalid display name');
  return value.trim();
}
export function validateInput(input: SendInput): SendInput {
  if (typeof input.text !== 'string' || !input.text.trim() || Buffer.byteLength(input.text, 'utf8') > 8192) fail('validation', 'Message body must be nonempty and at most 8 KiB UTF-8');
  if (!uuid.test(input.toPeerId)) fail('validation', 'Invalid toPeerId: use the full routing id returned by peers');
  if (input.inReplyTo !== undefined && !uuid.test(input.inReplyTo)) fail('validation', 'Invalid inReplyTo: use a message id, or omit it for a new message');
  return { toPeerId: input.toPeerId, text: input.text, ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}) };
}
export function payloadHash(input: SendInput): string { return createHash('sha256').update(JSON.stringify(validateInput(input))).digest('hex'); }
export function routeKey(fromPeerId: string, toPeerId: string): string { return `${fromPeerId}:${toPeerId}`; }
export function newLedger(authorityId: string): Ledger {
  if (!uuid.test(authorityId)) fail('validation', 'Invalid authority ID');
  return { version: 3, authorityId, sequence: 0, groups: {}, peers: {}, routes: {}, messages: {} };
}
function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function hasFields(value: Record<string, unknown>, fields: readonly string[]): boolean { return fields.every(field => Object.hasOwn(value, field)); }
function isNonnegativeInteger(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function isFiniteNumber(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function lifecycleTime(value: number): number {
  if (!isFiniteNumber(value)) fail('validation', 'Invalid lifecycle timestamp');
  return value;
}
function validateLedgerVersion(value: unknown, authorityId: string, version: 1): asserts value is LegacyLedgerV1;
function validateLedgerVersion(value: unknown, authorityId: string, version: 2): asserts value is LegacyLedgerV2;
function validateLedgerVersion(value: unknown, authorityId: string, version: 3): asserts value is Ledger;
function validateLedgerVersion(value: unknown, authorityId: string, version: 1 | 2 | 3): void {
  if (!isRecord(value) || !hasFields(value, ['version', 'authorityId', 'sequence', 'groups', 'peers', 'messages']) || value.version !== version || !isRecord(value.groups) || !isRecord(value.peers) || !isRecord(value.messages) || !isNonnegativeInteger(value.sequence)) fail('corrupt', 'Unsupported or corrupt messaging ledger');
  if (version === 3 && (!isRecord(value.routes) || Object.keys(value.routes).length > 1024)) fail('corrupt', 'Invalid route ledger');
  if (value.authorityId !== authorityId) fail('authority', 'Messaging authority mismatch; refusing replacement state');
  const groups = value.groups; const peers = value.peers; const messages = value.messages;
  if (Object.keys(groups).length > 32 || Object.keys(peers).length > 512 || Object.keys(messages).length > 2000) fail('corrupt', 'Ledger exceeds bounds');
  for (const [id, group] of Object.entries(groups)) {
    if (!isRecord(group) || !hasFields(group, ['authorityId', 'id', 'label', 'mode', 'round', 'limit', 'used']) || !uuid.test(id) || group.id !== id || group.authorityId !== authorityId || typeof group.label !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(group.label) || !['paused', 'armed', 'exhausted'].includes(typeof group.mode === 'string' ? group.mode : '') || !isNonnegativeInteger(group.used) || !isNonnegativeInteger(group.limit) || !isNonnegativeInteger(group.round) || group.used > group.limit || group.limit > 100 || (group.mode === 'exhausted' && group.used !== group.limit) || (group.mode === 'armed' && group.used >= group.limit)) fail('corrupt', 'Invalid group ledger');
  }
  for (const [id, peer] of Object.entries(peers)) {
    if (!isRecord(peer) || !hasFields(peer, ['id', 'groupId', 'sessionId', 'displayName', 'active', 'lastSeen']) || !uuid.test(id) || peer.id !== id || typeof peer.groupId !== 'string' || !Object.hasOwn(groups, peer.groupId) || typeof peer.active !== 'boolean' || typeof peer.sessionId !== 'string' || !isFiniteNumber(peer.lastSeen) || typeof peer.displayName !== 'string') fail('corrupt', 'Invalid peer ledger');
    validateDisplayName(peer.displayName);
    if (version >= 2) {
      if (!Object.hasOwn(peer, 'suspended') || typeof peer.suspended !== 'boolean') fail('corrupt', 'Invalid peer suspension state');
      if (!peer.active && peer.suspended) fail('corrupt', 'Inactive peers cannot be suspended');
      if (!Object.hasOwn(peer, 'leaseId') || typeof peer.leaseId !== 'string' || !uuid.test(peer.leaseId)) fail('corrupt', 'Invalid peer lease');
    }
  }
  if (version === 3) {
    for (const [key, route] of Object.entries(value.routes as Record<string, unknown>)) {
      if (!isRecord(route) || !hasFields(route, ['groupId', 'fromPeerId', 'toPeerId', 'mode']) || key !== routeKey(String(route.fromPeerId), String(route.toPeerId)) || !Object.hasOwn(peers, String(route.fromPeerId)) || !Object.hasOwn(peers, String(route.toPeerId)) || route.fromPeerId === route.toPeerId || !['open', 'closed', 'reply-only'].includes(String(route.mode))) fail('corrupt', 'Invalid route ledger');
      const from = peers[String(route.fromPeerId)] as Record<string, unknown>; const to = peers[String(route.toPeerId)] as Record<string, unknown>;
      if (route.groupId !== from.groupId || route.groupId !== to.groupId) fail('corrupt', 'Invalid route ledger');
    }
  }
  for (const [id, message] of Object.entries(messages)) {
    if (!isRecord(message) || !hasFields(message, ['id', 'sequence', 'groupId', 'senderPeerId', 'recipientPeerId', 'senderName', 'requestKey', 'hash', 'createdAt', 'state']) || !uuid.test(id) || message.id !== id || typeof message.groupId !== 'string' || !Object.hasOwn(groups, message.groupId) || typeof message.senderPeerId !== 'string' || !Object.hasOwn(peers, message.senderPeerId) || typeof message.recipientPeerId !== 'string' || !Object.hasOwn(peers, message.recipientPeerId)) fail('corrupt', 'Invalid message ledger');
    const sender = peers[message.senderPeerId]; const recipient = peers[message.recipientPeerId];
    if (!isRecord(sender) || !isRecord(recipient) || sender.groupId !== message.groupId || recipient.groupId !== message.groupId || !['queued', 'attempted', 'observed', 'canceled', 'dismissed', 'expired', 'terminal-unresolved'].includes(typeof message.state === 'string' ? message.state : '') || (version === 3 && !['legacy', 'notice', 'request', 'reply'].includes(String(message.kind))) || !isNonnegativeInteger(message.sequence) || message.sequence < 1 || message.sequence > value.sequence || typeof message.senderName !== 'string' || typeof message.requestKey !== 'string' || typeof message.hash !== 'string' || !/^[0-9a-f]{64}$/.test(message.hash) || !isFiniteNumber(message.createdAt)) fail('corrupt', 'Invalid message ledger');
    if ((message.inReplyTo !== undefined && typeof message.inReplyTo !== 'string') || (message.attemptId !== undefined && (typeof message.attemptId !== 'string' || !uuid.test(message.attemptId))) || (message.attemptRound !== undefined && !isNonnegativeInteger(message.attemptRound)) || (message.attemptedAt !== undefined && !isFiniteNumber(message.attemptedAt)) || (message.observedAt !== undefined && !isFiniteNumber(message.observedAt)) || (message.terminalAt !== undefined && !isFiniteNumber(message.terminalAt))) fail('corrupt', 'Invalid optional message ledger');
    if (['attempted', 'observed', 'dismissed'].includes(typeof message.state === 'string' ? message.state : '') && (!hasFields(message, ['attemptId', 'attemptRound', 'attemptedAt']) || typeof message.attemptId !== 'string' || !uuid.test(message.attemptId) || !isNonnegativeInteger(message.attemptRound) || !isFiniteNumber(message.attemptedAt))) fail('corrupt', 'Invalid attempt ledger');
  }
}
export function validateLedger(value: unknown, authorityId: string): asserts value is Ledger { validateLedgerVersion(value, authorityId, 3); }
export function migrateLedger(value: unknown, authorityId: string, _now = Date.now()): { ledger: Ledger; migrated: boolean } {
  if (isRecord(value) && value.version === 3) { validateLedger(value, authorityId); return { ledger: value, migrated: false }; }
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2)) fail('corrupt', 'Unsupported or corrupt messaging ledger');
  let peers: Record<string, StoredPeer>;
  if (value.version === 1) {
    validateLedgerVersion(value, authorityId, 1);
    peers = Object.fromEntries(Object.entries(value.peers).map(([id, peer]) => [id, { ...peer, suspended: false, leaseId: randomUUID() }]));
  } else {
    validateLedgerVersion(value, authorityId, 2);
    peers = Object.fromEntries(Object.entries(value.peers).map(([id, peer]) => [id, { ...peer }]));
  }
  const routes: Record<string, Route> = {};
  const current = Object.values(peers).filter(peer => peer.active);
  for (const from of current) for (const to of current) if (from.id !== to.id && from.groupId === to.groupId) routes[routeKey(from.id, to.id)] = { groupId: from.groupId, fromPeerId: from.id, toPeerId: to.id, mode: 'open' };
  const ledger: Ledger = {
    version: 3, authorityId: value.authorityId, sequence: value.sequence,
    groups: Object.fromEntries(Object.entries(value.groups).map(([id, group]) => [id, { ...group }])), peers, routes,
    messages: Object.fromEntries(Object.entries(value.messages).map(([id, message]) => [id, { ...message, kind: 'legacy' as const }])),
  };
  validateLedger(ledger, authorityId); return { ledger, migrated: true };
}
export function publicPeer(peer: StoredPeer): Peer {
  return { id: peer.id, groupId: peer.groupId, sessionId: peer.sessionId, displayName: peer.displayName, active: peer.active, suspended: peer.suspended, lastSeen: peer.lastSeen, ...(peer.suspendedAt !== undefined ? { suspendedAt: peer.suspendedAt } : {}), ...(peer.endedAt !== undefined ? { endedAt: peer.endedAt } : {}), ...(peer.endReason !== undefined ? { endReason: peer.endReason } : {}) };
}
export function peerPresence(peer: Peer, now = Date.now()): PeerPresence {
  lifecycleTime(now);
  if (!peer.active) return 'left';
  if (peer.suspended) return 'suspended';
  return now - peer.lastSeen <= ONLINE_WINDOW_MS ? 'online' : 'stale';
}
export function groupOf(s: Ledger, ref: GroupRef): Group {
  if (ref.authorityId !== s.authorityId) fail('authority', 'Messaging authority mismatch');
  const g = Object.hasOwn(s.groups, ref.id) ? s.groups[ref.id] : undefined;
  if (!g) fail('missing', 'Group does not exist');
  return g;
}
export function activePeer(s: Ledger, id: string): StoredPeer {
  const peer = Object.hasOwn(s.peers, id) ? s.peers[id] : undefined;
  if (!peer?.active) fail('participation', 'Peer is not active; explicitly join again');
  return peer;
}
export function leaseOf(peer: StoredPeer): ParticipantLease { return { peerId: peer.id, leaseId: peer.leaseId }; }
function authorizeLease(s: Ledger, value: unknown): StoredPeer {
  if (!value || typeof value !== 'object' || !Object.hasOwn(value, 'peerId') || !Object.hasOwn(value, 'leaseId')) fail('participation', 'A current peer lease is required');
  const lease = value as Record<string, unknown>;
  if (typeof lease.peerId !== 'string' || typeof lease.leaseId !== 'string' || !uuid.test(lease.peerId) || !uuid.test(lease.leaseId)) fail('participation', 'A current peer lease is required');
  const peer = Object.hasOwn(s.peers, lease.peerId) ? s.peers[lease.peerId] : undefined;
  if (!peer?.active || peer.suspended || peer.leaseId !== lease.leaseId) fail('participation', 'Peer lease is no longer current; explicitly resume or join again');
  return peer;
}
export function requireLease(s: Ledger, lease: ParticipantLease): StoredPeer { return authorizeLease(s, lease); }
export function refOf(g: Group): GroupRef { return { authorityId: g.authorityId, id: g.id, label: g.label }; }
export function createGroup(s: Ledger, label: string): GroupRef {
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(label)) fail('validation', 'Group label must be 1–48 lowercase letters/digits/hyphens, starting with a letter');
  const existing = Object.values(s.groups).find(g => g.label === label);
  if (existing) return refOf(existing);
  if (Object.keys(s.groups).length >= 32) fail('full', 'Group store full; prune inactive groups');
  const g: Group = { authorityId: s.authorityId, id: randomUUID(), label, mode: 'paused', round: 0, limit: 0, used: 0 };
  s.groups[g.id] = g; return refOf(g);
}
export function joinPeer(s: Ledger, ref: GroupRef, info: { sessionId: string; displayName: string }, now = Date.now()): StoredPeer {
  const group = groupOf(s, ref); const joinedAt = lifecycleTime(now);
  if (Object.keys(s.peers).length >= 512 || Object.values(s.peers).filter(p => p.groupId === group.id && p.active).length >= 16) fail('full', 'Peer store full; leave/revoke and prune old peers');
  if (!info.sessionId || info.sessionId.length > 256) fail('validation', 'Invalid session ID');
  const peer: StoredPeer = { id: randomUUID(), groupId: group.id, sessionId: info.sessionId, displayName: validateDisplayName(info.displayName), active: true, suspended: false, lastSeen: joinedAt, leaseId: randomUUID() };
  for (const other of Object.values(s.peers)) if (other.groupId === group.id && other.active) {
    s.routes[routeKey(peer.id, other.id)] = { groupId: group.id, fromPeerId: peer.id, toPeerId: other.id, mode: 'open' };
    s.routes[routeKey(other.id, peer.id)] = { groupId: group.id, fromPeerId: other.id, toPeerId: peer.id, mode: 'open' };
  }
  s.peers[peer.id] = peer; return peer;
}
export function resumePeer(s: Ledger, ref: GroupRef, sessionId: string, peerId: string, now = Date.now()): StoredPeer {
  const resumedAt = lifecycleTime(now); const group = groupOf(s, ref);
  const peer = Object.hasOwn(s.peers, peerId) ? s.peers[peerId] : undefined;
  if (!peer || peer.groupId !== group.id || peer.sessionId !== sessionId) fail('participation', 'Peer does not belong to this session and group');
  if (!peer.active) fail('participation', 'Peer was explicitly left or revoked');
  if (peerPresence(peer, resumedAt) === 'online') fail('participation', 'Matching messaging peer is still online; return to it or explicitly revoke it');
  const nextLeaseId = randomUUID(); peer.suspended = false; delete peer.suspendedAt; peer.leaseId = nextLeaseId; peer.lastSeen = resumedAt; return peer;
}
export function takeoverPeer(s: Ledger, ref: GroupRef, sessionId: string, peerId: string, now = Date.now()): StoredPeer {
  const takenAt = lifecycleTime(now); const group = groupOf(s, ref);
  const peer = Object.hasOwn(s.peers, peerId) ? s.peers[peerId] : undefined;
  if (!peer || peer.groupId !== group.id || !peer.active) fail('participation', 'Member is not available for takeover');
  if (peerPresence(peer, takenAt) === 'online') fail('participation', 'Online member cannot be taken over');
  if (!sessionId || sessionId.length > 256) fail('validation', 'Invalid session ID');
  peer.sessionId = sessionId; peer.suspended = false; delete peer.suspendedAt;
  peer.lastSeen = takenAt; peer.leaseId = randomUUID(); return peer;
}
function finalizePeer(s: Ledger, peer: StoredPeer, reason: 'leave' | 'revoke' | 'expired', now: number): void {
  peer.active = false; peer.suspended = false; delete peer.suspendedAt; peer.endedAt = lifecycleTime(now); peer.endReason = reason; peer.leaseId = randomUUID();
  for (const [key, route] of Object.entries(s.routes)) if (route.fromPeerId === peer.id || route.toPeerId === peer.id) delete s.routes[key];
}
export function suspendPeer(s: Ledger, lease: ParticipantLease, now = Date.now()): void {
  const peer = requireLease(s, lease); peer.suspended = true; peer.suspendedAt = lifecycleTime(now); peer.leaseId = randomUUID();
}
export function leavePeer(s: Ledger, lease: ParticipantLease, now = Date.now()): void {
  const peer = authorizeLease(s, lease); finalizePeer(s, peer, 'leave', now);
}
export function revokePeer(s: Ledger, ref: GroupRef, peerId: string, now = Date.now()): void {
  const group = groupOf(s, ref); const peer = Object.hasOwn(s.peers, peerId) ? s.peers[peerId] : undefined;
  if (!peer || peer.groupId !== group.id) fail('missing', 'Peer not in group');
  finalizePeer(s, peer, 'revoke', now);
}
export function heartbeat(s: Ledger, lease: ParticipantLease, displayName?: string): void {
  const peer = authorizeLease(s, lease); const nextName = displayName === undefined ? undefined : validateDisplayName(displayName);
  peer.lastSeen = Date.now(); if (nextName !== undefined) peer.displayName = nextName;
}
export function arm(s: Ledger, ref: GroupRef, limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('validation', 'Allowance must be an integer from 1 to 100');
  const g = groupOf(s, ref);
  const queued = queuedInGroup(s, g.id).length;
  if (limit < queued) fail('allowance', `Allowance must cover ${queued} already queued message${queued === 1 ? '' : 's'}`);
  g.round++; g.limit = limit; g.used = 0; g.mode = 'armed';
}
export function pause(s: Ledger, ref: GroupRef): void { groupOf(s, ref).mode = 'paused'; }
export function prepareMessage(s: Ledger, senderLease: ParticipantLease, input: SendInput, requestKey: string): MessageStatus {
  const sender = authorizeLease(s, senderLease); validateInput(input);
  if (!requestKey || requestKey.length > 512) fail('validation', 'Invalid request key');
  const hash = payloadHash(input);
  const existing = Object.values(s.messages).find(m => m.senderPeerId === sender.id && m.requestKey === requestKey);
  if (existing) { if (existing.hash !== hash) fail('conflict', 'Send idempotency conflict'); return existing; }
  const recipient = activePeer(s, input.toPeerId);
  if (sender.id === recipient.id || sender.groupId !== recipient.groupId) fail('validation', 'Recipient must be another peer in the same group');
  if (input.inReplyTo && (!Object.hasOwn(s.messages, input.inReplyTo) || s.messages[input.inReplyTo].groupId !== sender.groupId)) fail('validation', 'Reply reference is not in this group');
  if (Object.values(s.messages).some(message => message.senderPeerId === sender.id && unresolved(message))) fail('busy', 'Sender already has an unresolved outbound message');
  const group = s.groups[sender.groupId];
  const queued = queuedInGroup(s, group.id);
  if (queued.filter(message => message.recipientPeerId === recipient.id).length >= MAX_QUEUED_PER_RECIPIENT) fail('full', 'Recipient already has eight queued messages');
  if (group.limit - group.used - queued.length <= 0) fail('allowance', 'No unspent messaging allowance remains for another queued message');
  if (Object.keys(s.messages).length >= 2000 || Object.values(s.messages).filter(m => m.groupId === sender.groupId && ['queued', 'attempted'].includes(m.state)).length >= 64) fail('full', 'Message queue/store full; cancel, dismiss, or prune from the human inbox');
  if (s.sequence >= Number.MAX_SAFE_INTEGER) fail('full', 'Sequence exhausted');
  const m: MessageStatus = { id: randomUUID(), sequence: ++s.sequence, groupId: sender.groupId, senderPeerId: sender.id, recipientPeerId: recipient.id, senderName: sender.displayName, requestKey, hash, createdAt: Date.now(), kind: 'legacy', state: 'queued', ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}) };
  s.messages[m.id] = m; return m;
}
export function canReceive(s: Ledger, recipientLease: ParticipantLease): boolean {
  const peer = authorizeLease(s, recipientLease); const group = s.groups[peer.groupId];
  return group.mode === 'armed' && group.used < group.limit && !Object.values(s.messages).some(m => m.recipientPeerId === peer.id && m.state === 'attempted');
}
export function admitBatch(s: Ledger, recipientLease: ParticipantLease, messageIds: readonly string[]): Reservation[] {
  const peer = authorizeLease(s, recipientLease);
  if (messageIds.length === 0) return [];
  if (messageIds.length > MAX_QUEUED_PER_RECIPIENT || new Set(messageIds).size !== messageIds.length) fail('validation', 'Invalid messaging batch');
  const group = s.groups[peer.groupId];
  if (group.mode !== 'armed' || group.used >= group.limit || Object.values(s.messages).some(m => m.recipientPeerId === peer.id && m.state === 'attempted')) return [];
  const selected: MessageStatus[] = [];
  for (const id of messageIds) {
    const message = Object.hasOwn(s.messages, id) ? s.messages[id] : undefined;
    if (!message || message.state !== 'queued') continue;
    if (message.recipientPeerId !== peer.id || message.groupId !== group.id) fail('corrupt', 'Batch candidate belongs to another inbox');
    if (selected.length < group.limit - group.used) selected.push(message);
  }
  const now = Date.now();
  return selected.map(message => {
    message.state = 'attempted'; message.attemptId = randomUUID(); message.attemptRound = group.round; message.attemptedAt = now;
    if (++group.used === group.limit) group.mode = 'exhausted';
    return { group: refOf(group), peerId: peer.id, message: { ...message }, attemptId: message.attemptId, round: group.round };
  });
}
export function admit(s: Ledger, recipientLease: ParticipantLease, messageId: string): Reservation | null { return admitBatch(s, recipientLease, [messageId])[0] ?? null; }
export function observeBatch(s: Ledger, recipientLease: ParticipantLease, reservations: readonly Reservation[]): void {
  const peer = authorizeLease(s, recipientLease);
  if (!reservations) fail('participation', 'A current peer lease is required');
  if (reservations.length === 0 || reservations.length > MAX_QUEUED_PER_RECIPIENT) fail('receipt', 'Invalid receipt batch');
  const ids = reservations.map(reservation => reservation.message.id);
  if (new Set(ids).size !== ids.length) fail('receipt', 'Duplicate receipt correlation');
  const first = reservations[0];
  const group = groupOf(s, first.group);
  if (peer.groupId !== group.id || first.peerId !== peer.id) fail('receipt', 'Receipt does not belong to this participant');
  const messages = reservations.map(reservation => {
    if (reservation.peerId !== peer.id || reservation.group.id !== first.group.id || reservation.group.authorityId !== first.group.authorityId) fail('receipt', 'Mixed receipt batch');
    const message = Object.hasOwn(s.messages, reservation.message.id) ? s.messages[reservation.message.id] : undefined;
    if (!message || message.groupId !== reservation.group.id || message.recipientPeerId !== reservation.peerId || message.attemptId !== reservation.attemptId || message.attemptRound !== reservation.round || !['attempted', 'observed', 'dismissed'].includes(message.state)) fail('receipt', 'Invalid receipt correlation');
    return message;
  });
  const now = Date.now();
  for (const message of messages) {
    message.observedAt ??= now;
    if (message.state === 'attempted') { message.state = 'observed'; message.terminalAt = now; }
  }
}
export function observe(s: Ledger, recipientLease: ParticipantLease, reservation: Reservation): void { observeBatch(s, recipientLease, [reservation]); }
export function resolveMessage(s: Ledger, ref: GroupRef, id: string, state: 'canceled' | 'dismissed'): void {
  groupOf(s, ref); const m = Object.hasOwn(s.messages, id) ? s.messages[id] : undefined;
  if (!m || m.groupId !== ref.id || (state === 'canceled' ? m.state !== 'queued' : state !== 'dismissed' || m.state !== 'attempted')) fail('validation', 'Message is not eligible for that recovery action');
  m.state = state; m.terminalAt = Date.now();
}
export function prunable(s: Ledger, ref: GroupRef, before: number): string[] {
  groupOf(s, ref);
  return Object.values(s.messages).filter(m => m.groupId === ref.id && ['observed', 'canceled', 'dismissed'].includes(m.state) && !s.peers[m.senderPeerId].active && (m.terminalAt ?? Infinity) < before).map(m => m.id);
}
export function summary(s: Ledger, ref: GroupRef): GroupSummary {
  const g = groupOf(s, ref);
  return { group: refOf(g), mode: g.mode, roundNumber: g.round, limit: g.limit, used: g.used, remaining: g.limit - g.used, onlinePeers: Object.values(s.peers).filter(p => p.groupId === g.id && peerPresence(p) === 'online').length, pendingCount: Object.values(s.messages).filter(m => m.groupId === g.id && ['queued', 'attempted'].includes(m.state)).length };
}
export function envelope(s: Ledger, m: MessageStatus, text: string): Envelope {
  return { version: 1, authorityId: s.authorityId, groupId: m.groupId, messageId: m.id, senderPeerId: m.senderPeerId, recipientPeerId: m.recipientPeerId, senderName: m.senderName, createdAt: m.createdAt, text, ...(m.inReplyTo ? { inReplyTo: m.inReplyTo } : {}) };
}
export function validateEnvelope(e: Envelope, s: Ledger, m: MessageStatus): void {
  if (!e || e.version !== 1 || e.authorityId !== s.authorityId || e.groupId !== m.groupId || e.messageId !== m.id || e.senderPeerId !== m.senderPeerId || e.recipientPeerId !== m.recipientPeerId || e.senderName !== m.senderName || e.createdAt !== m.createdAt || e.inReplyTo !== m.inReplyTo || payloadHash({ toPeerId: e.recipientPeerId, text: e.text, ...(e.inReplyTo ? { inReplyTo: e.inReplyTo } : {}) }) !== m.hash) fail('corrupt', 'Message envelope does not match authoritative metadata');
}
