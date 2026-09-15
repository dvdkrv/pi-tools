import { StringEnum } from '@earendil-works/pi-ai';
import { Type, type Static } from 'typebox';
import { fail } from './policy.ts';

export const peerMessageParameters = Type.Object({
  action: StringEnum(['peers', 'status', 'send', 'rename'] as const),
  displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 64, description: 'rename only: concise name describing your existing assigned role; omit for other actions' })),
  toPeerId: Type.Optional(Type.String({ description: 'send only: full peers[].id routing ID, not sessionId or displayName; omit for other actions' })),
  text: Type.Optional(Type.String({ description: 'send only: nonempty message body, at most 8 KiB UTF-8; omit for other actions' })),
  inReplyTo: Type.Optional(Type.String({ description: 'send only: optional message ID being replied to, not a peer ID; omit or leave empty for a new message' })),
  beforeSequence: Type.Optional(Type.Integer({ minimum: 1, description: 'status only: cursor from nextBeforeSequence for an older page; omit for the first page' })),
}, { additionalProperties: false });
export type PeerMessageArguments = Static<typeof peerMessageParameters>;

/** Normalize neutral shared-schema padding before Pi can coerce null into "null" or 0. */
export function preparePeerMessageArguments(raw: unknown): PeerMessageArguments {
  // Leave malformed roots for Pi's schema validator; no state or I/O belongs here.
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw as PeerMessageArguments;
  const args = { ...raw } as Record<string, unknown>;
  if (args.action === 'rename' && typeof args.displayName !== 'string') fail('validation', 'rename requires a string displayName');
  if (args.action === 'send' && (typeof args.toPeerId !== 'string' || typeof args.text !== 'string')) fail('validation', 'send requires string toPeerId and text');
  for (const key of ['displayName', 'toPeerId', 'text', 'inReplyTo', 'beforeSequence']) {
    const required = (key === 'displayName' && args.action === 'rename') || (['toPeerId', 'text'].includes(key) && args.action === 'send');
    if (!required && (args[key] === '' || args[key] === null || args[key] === undefined)) delete args[key];
  }
  // Pagination has no meaning for other actions. Meaningful rename targets/content and
  // unknown keys are deliberately retained so validation still rejects them.
  if (args.action !== 'status') delete args.beforeSequence;
  return args as PeerMessageArguments;
}
