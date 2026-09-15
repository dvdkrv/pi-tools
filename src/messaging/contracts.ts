export type MessageState = 'queued' | 'attempted' | 'observed' | 'canceled' | 'dismissed';
export interface GroupRef { authorityId: string; id: string; label: string }
export interface Group extends GroupRef { mode: 'paused' | 'armed' | 'exhausted'; round: number; limit: number; used: number }
export type PeerPresence = 'online' | 'stale' | 'suspended' | 'left';
export interface Peer { id: string; groupId: string; sessionId: string; displayName: string; active: boolean; suspended: boolean; lastSeen: number }
export interface ParticipantLease { readonly peerId: string; readonly leaseId: string }
export interface StoredPeer extends Peer { leaseId: string }
export interface MessageStatus {
  id: string; sequence: number; groupId: string; senderPeerId: string; recipientPeerId: string;
  senderName: string; requestKey: string; hash: string; createdAt: number; state: MessageState;
  inReplyTo?: string; attemptId?: string; attemptRound?: number; attemptedAt?: number; observedAt?: number; terminalAt?: number;
}
export interface Envelope {
  version: 1; authorityId: string; groupId: string; messageId: string;
  senderPeerId: string; recipientPeerId: string; senderName: string;
  createdAt: number; text: string; inReplyTo?: string;
}
export interface Reservation { group: GroupRef; peerId: string; message: MessageStatus; attemptId: string; round: number; envelope?: Envelope }
export interface SendInput { toPeerId: string; text: string; inReplyTo?: string }
export interface GroupSummary {
  group: GroupRef; mode: Group['mode']; roundNumber: number; limit: number; used: number; remaining: number;
  onlinePeers: number; pendingCount: number;
}
export interface MessagingReader { getGroupSummary(ref: GroupRef): Promise<GroupSummary | null>; close(): Promise<void> }
export interface MessagingBackend extends MessagingReader {
  readonly peer: Peer | undefined;
  readonly closed: boolean;
  listGroups(): Promise<GroupRef[]>;
  createGroup(label: string): Promise<GroupRef>;
  join(ref: GroupRef, info: { sessionId: string; displayName: string }): Promise<Peer>;
  resume(ref: GroupRef, peerId: string, sessionId: string): Promise<Peer>;
  suspend(): Promise<void>;
  leave(): Promise<void>;
  heartbeat(displayName?: string): Promise<void>;
  arm(ref: GroupRef, limit: number): Promise<void>;
  pause(ref: GroupRef): Promise<void>;
  peers(ref: GroupRef): Promise<Peer[]>;
  send(input: SendInput, requestKey: string): Promise<MessageStatus>;
  reserve(): Promise<Reservation[]>;
  observe(reservations: readonly Reservation[]): Promise<void>;
  listMessages(ref: GroupRef): Promise<MessageStatus[]>;
  readBody(ref: GroupRef, id: string): Promise<Envelope | null>;
  resolveMessage(ref: GroupRef, id: string, state: 'canceled' | 'dismissed'): Promise<void>;
  revoke(ref: GroupRef, id: string): Promise<void>;
  prune(ref: GroupRef, execute?: boolean, before?: number): Promise<string[]>;
  onChange(callback: () => void): () => void;
}
export interface BrokerConfig { version: 1; authorityId: string; server: string; token: string; initialized: boolean }
export class MessagingError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = 'MessagingError'; this.code = code; }
}
