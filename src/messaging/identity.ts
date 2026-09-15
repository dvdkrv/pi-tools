import type { Peer } from './contracts.ts';
import { safeText } from './policy.ts';

export const API_GUIDANCE = 'Use peer_message action peers to obtain your current messaging identity and routing IDs when an assigned exchange requires messaging. Use API results rather than assuming identity from conversation context. If your human-assigned role is known and your current display name is still the session ID, action rename may set a concise role name. Do not invent work, poll, send introductions, or repeatedly rename.';
export const QUIET_GUIDANCE = 'In an explicitly joined group, use peer_message only for a requested exchange or a substantive blocker, contract change, or completion needed by your assigned work. Queue the message and continue that work; do not wait for a reply, poll status, send periodic updates, or acknowledge receipts unless the human asked. If blocked on a reply, report the blocker and end the current run so queued messages can arrive. Do not automatically retry uncertain messaging outcomes.';

/** Session IDs identify conversations for humans, not fresh routing memberships. */
export function peerLabel(peer: Pick<Peer, 'displayName' | 'sessionId'>): string {
  const session = `session ${safeText(peer.sessionId).replace(/[\r\n\t]/g, ' ').slice(0, 8)}`;
  return peer.displayName === peer.sessionId ? session : `${safeText(peer.displayName).replace(/[\r\n\t]/g, ' ')} · ${session}`;
}
