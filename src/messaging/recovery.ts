import { MessagingError } from './contracts.ts';

export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  return Math.round(Math.min(60_000, 1000 * 2 ** attempt) * (0.75 + 0.25 * random()));
}

/** Transport failures and transient contention. 'busy' is a protocol or UI rejection (e.g. an unresolved outbound message) and never triggers a reconnect. */
export function isRecoverable(error: unknown): boolean {
  return !(error instanceof MessagingError) || ['uncertain', 'unavailable', 'contended'].includes(error.code);
}
