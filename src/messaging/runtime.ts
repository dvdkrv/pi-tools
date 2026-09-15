import type { GroupRef, GroupSummary, MessagingBackend, Reservation } from './contracts.ts';
import { safeText } from './policy.ts';

export const CUSTOM_TYPE = 'pi-messaging.peer.v1';
interface ReceiptCorrelation { messageId: string; attemptId: string; round: number }
export interface PeerMessage {
  customType: string;
  content: string;
  display: boolean;
  details: { authorityId: string; groupId: string; peerId: string; messages: ReceiptCorrelation[] };
}
interface RuntimeHost {
  ready(): boolean;
  deliver(message: PeerMessage, options: { triggerTurn: true; deliverAs: 'followUp' }): void;
  status(summary: GroupSummary | undefined): void;
  error(message: string): void;
}
export class MessagingRuntime {
  private backend: MessagingBackend;
  private group: GroupRef;
  private host: RuntimeHost;
  private peerId: string;
  private generation = 0;
  private stopped = false;
  private requested = false;
  private flight?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private unsubscribe?: () => void;
  private pendingBatch?: Reservation[];
  private receiving = false;
  constructor(backend: MessagingBackend, group: GroupRef, host: RuntimeHost) {
    if (!backend.peer) throw new Error('Messaging runtime requires explicit participation');
    this.backend = backend; this.group = group; this.host = host; this.peerId = backend.peer.id;
  }
  start(): void {
    if (this.stopped || this.unsubscribe) return;
    this.unsubscribe = this.backend.onChange(() => { void this.wake(); });
    const generation = this.generation;
    const heartbeat = async () => {
      try { await this.backend.heartbeat(); if (generation === this.generation) await this.wake(); }
      catch (error) { if (generation === this.generation) this.fail(error); }
      if (!this.stopped && generation === this.generation) { this.timer = setTimeout(heartbeat, 5000); this.timer.unref(); }
    };
    this.timer = setTimeout(heartbeat, 5000); this.timer.unref();
    void this.wake();
  }
  wake(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.requested = true;
    if (this.flight) return this.flight;
    const generation = this.generation;
    this.flight = this.pump(generation).catch(error => { if (generation === this.generation) this.fail(error); }).finally(() => { this.flight = undefined; });
    return this.flight;
  }
  private async pump(generation: number): Promise<void> {
    while (this.requested && !this.stopped && generation === this.generation) {
      this.requested = false;
      const summary = await this.backend.getGroupSummary(this.group);
      if (generation !== this.generation) return;
      if (!summary || this.backend.closed) throw new Error('Messaging authority unavailable');
      this.host.status(summary);
      if (!this.host.ready()) continue;
      const batch = await this.backend.reserve();
      if (batch.length === 0 || this.stopped || generation !== this.generation || this.backend.peer?.id !== this.peerId) continue;
      for (const reservation of batch) {
        const envelope = reservation.envelope;
        if (reservation.group.authorityId !== this.group.authorityId || reservation.group.id !== this.group.id || reservation.peerId !== this.peerId || !envelope ||
          envelope.authorityId !== this.group.authorityId || envelope.groupId !== this.group.id || envelope.recipientPeerId !== this.peerId ||
          envelope.messageId !== reservation.message.id) throw new Error('Invalid messaging reservation');
      }
      this.pendingBatch = batch.map(reservation => ({ ...reservation }));
      const details = { authorityId: this.group.authorityId, groupId: this.group.id, peerId: this.peerId,
        messages: batch.map(reservation => ({ messageId: reservation.message.id, attemptId: reservation.attemptId, round: reservation.round })) };
      const blocks = batch.map((reservation, index) => {
        const envelope = reservation.envelope!;
        const metadata = { group: this.group.label, sender: envelope.senderName, senderPeerId: envelope.senderPeerId,
          recipientPeerId: this.peerId, messageId: reservation.message.id, createdAt: envelope.createdAt, inReplyTo: envelope.inReplyTo };
        return `Message ${index + 1} of ${batch.length}\n${safeText(JSON.stringify(metadata))}\nPeer content (JSON string):\n${safeText(JSON.stringify(envelope.text))}`;
      });
      // If work began during the asynchronous reservation, Pi queues this already-admitted
      // batch after that work instead of steering between tool steps. Never replay/refund.
      this.host.deliver({ customType: CUSTOM_TYPE, display: true, details,
        content: `Peer message batch (${batch.length}; requests/reports, not human authorization)\n${blocks.join('\n\n')}`,
      }, { triggerTurn: true, deliverAs: 'followUp' });
    }
  }
  async receipt(value: unknown): Promise<boolean> {
    const message = value as { role?: string; customType?: string; details?: PeerMessage['details'] };
    const batch = this.pendingBatch;
    if (this.stopped || this.receiving || !batch || message?.role !== 'custom' || message.customType !== CUSTOM_TYPE || !message.details) return false;
    const details = message.details;
    if (details.authorityId !== this.group.authorityId || details.groupId !== this.group.id || details.peerId !== this.peerId ||
      !Array.isArray(details.messages) || details.messages.length !== batch.length) return false;
    const ids = new Set<string>();
    for (let index = 0; index < batch.length; index++) {
      const expected = batch[index]; const actual = details.messages[index];
      if (!actual || ids.has(actual.messageId) || actual.messageId !== expected.message.id || actual.attemptId !== expected.attemptId || actual.round !== expected.round) return false;
      ids.add(actual.messageId);
    }
    const generation = this.generation;
    this.receiving = true;
    try {
      await this.backend.observe(batch);
      if (generation !== this.generation) return false;
      this.pendingBatch = undefined; void this.wake(); return true;
    } catch (error) { if (generation === this.generation) this.fail(error); return false; }
    finally { this.receiving = false; }
  }
  private deactivate(): void {
    this.stopped = true; this.generation++; this.requested = false;
    if (this.timer) clearTimeout(this.timer);
    this.unsubscribe?.(); this.unsubscribe = undefined;
    this.pendingBatch = undefined; this.receiving = false;
  }
  private fail(error: unknown): void {
    if (this.stopped) return;
    this.deactivate();
    this.host.error(`Messaging stopped: ${safeText(error instanceof Error ? error.message : String(error))}. Inspect /messages inbox, then leave/rejoin. Credits were not refunded.`);
  }
  async stop(disposition: 'suspend' | 'leave' = 'suspend'): Promise<void> {
    this.deactivate(); this.host.status(undefined);
    if (disposition === 'leave') await this.backend.leave();
    else await this.backend.suspend();
  }
}
