import type { BrokerConfig, GroupRef, MessagingReader } from './contracts.ts';
import { validateConfig } from './config.ts';
import { connectBackend } from './nats-backend.ts';
export type { GroupRef, GroupSummary, MessagingReader, MessageStatus } from './contracts.ts';

/** A separate read-only connection. Never initializes storage or restores participation. */
export async function connectReader(config: BrokerConfig): Promise<MessagingReader> {
  validateConfig(config);
  const backend = await connectBackend(config);
  return Object.freeze({
    getGroupSummary: (ref: GroupRef) => backend.getGroupSummary(ref),
    close: () => backend.close(),
  });
}
