import { join } from 'node:path';
import type { MessageLogEntry } from '../work/types.ts';
import { defaultDataDir, loadWorkConfig, messagingConfig } from '../work/config.ts';
import { sessionDisplayName } from '../work/display.ts';
import { pidAlive } from '../work/liveness.ts';
import { repoFromCwd } from '../work/rules.ts';
import { WorkStore } from '../work/store.ts';
import { validateDisplayName } from './policy.ts';

export interface MessagingSettings { autoJoin: boolean; sendsPerHour: number; paused: boolean | string[]; retentionDays: number; routeCooldownMinutes: number }
export type RegistryLiveness = 'live' | 'ended' | 'unknown';
export interface MessagingRegistry { displayName(sessionId: string, cwd: string): string | undefined; liveness(sessionId: string): RegistryLiveness }
export interface MessagingAudit { record(entry: MessageLogEntry): void; openIds(): string[]; setStates(updates: { id: string; state: string; at: string }[]): void; prune(before: string): void }
export interface MessagingOptions { settings?: () => MessagingSettings; registry?: MessagingRegistry; audit?: MessagingAudit; env?: NodeJS.ProcessEnv }
export const INERT_MESSAGING_SETTINGS: MessagingSettings = { autoJoin: false, sendsPerHour: 10, paused: false, retentionDays: 30, routeCooldownMinutes: 10 };

export function liveMessagingOptions(): MessagingOptions {
  let settings = INERT_MESSAGING_SETTINGS; let settingsAt = Number.NEGATIVE_INFINITY; let store: WorkStore | undefined;
  const repos = new Map<string, string | undefined>();
  const workStore = (): WorkStore | undefined => {
    try { return store ??= WorkStore.open(join(defaultDataDir(), 'work.db')); }
    catch { return undefined; }
  };
  return {
    env: process.env,
    settings: () => {
      const now = Date.now();
      if (now - settingsAt >= 5000) {
        settingsAt = now;
        try { settings = messagingConfig(loadWorkConfig().config); } catch { /* keep the last safe settings */ }
      }
      return settings;
    },
    registry: {
      displayName(sessionId, cwd) {
        try {
          const session = workStore()?.getSession(sessionId); if (!session) return undefined;
          if (!repos.has(cwd)) repos.set(cwd, repoFromCwd(cwd));
          return validateDisplayName([...sessionDisplayName(session.tmuxWindow, repos.get(cwd) ?? null, cwd)].slice(0, 64).join(''));
        } catch { return undefined; }
      },
      liveness(sessionId) {
        try {
          const session = workStore()?.getSession(sessionId); if (!session) return 'unknown';
          return pidAlive(session.pid, session.tmuxPane) ? 'live' : 'ended';
        } catch { return 'unknown'; }
      },
    },
    audit: {
      record: entry => { try { workStore()?.logMessage(entry); } catch { /* audit is best effort */ } },
      openIds: () => { try { return workStore()?.openMessageIds() ?? []; } catch { return []; } },
      setStates: updates => { try { workStore()?.setMessageStates(updates); } catch { /* audit is best effort */ } },
      prune: before => { try { workStore()?.pruneMessageLog(before); } catch { /* audit is best effort */ } },
    },
  };
}
