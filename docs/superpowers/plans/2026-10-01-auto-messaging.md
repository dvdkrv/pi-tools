# Automatic lateral messaging with an audit log (W-10, v0.4.3)

Goal: every top-level Pi session takes part in lateral messaging without manual joining, arming, or renaming, and the user can read every message in an audit log. The protocol and its loop protections stay: notice/request/reply rules, one unresolved outbound message per sender, at most 8 queued per recipient, delivery at idle boundaries.

## Global constraints

- Targeted tests only (`node --test <file>`). NATS only through `tests/messaging/helpers/broker.mjs` (`brokerFixture`); real tmux only on an isolated server (`tmux -L <unique>`).
- Never write an employer name or real home paths into the repo (`npm run check` enforces this).
- Agents must never read message bodies through tools. Only the user reads them: the dashboard Messages section and `work messages`.
- Code style: match the file you edit (messaging uses 2-space dense TypeScript; work uses tabs).

## Config (work config, `${XDG_CONFIG_HOME:-~/.config}/work/config.json`)

```json
"messaging": { "autoJoin": true, "sendsPerHour": 10, "paused": false, "retentionDays": 30, "routeCooldownMinutes": 10 }
```

- `autoJoin` (boolean, default `true`): top-level TUI sessions join the host group at start.
- `sendsPerHour` (positive integer, default `10`, at most 1000): each session's send budget, refilling continuously; the budget holds at most one hour's worth.
- `paused` (default `false`): `true` pauses messaging host-wide, or a list of session display names or session-id prefixes pauses those sessions. A paused session neither sends nor receives automatically; its queued messages wait (and expire after one hour).
- `retentionDays` (positive integer, default `30`): audit log retention.
- `routeCooldownMinutes` (positive number, default `10`): in the host group, a route closed by the protocol (after a notice or a reply) reopens after this long. Human-closed routes stay closed.

Invalid values produce a warning and fall back to the default, like the other sections.

## Task A: work registry (store, migration, config, CLI)

- Migration 4 (append to `MIGRATIONS`):

```sql
CREATE TABLE message_log (
	id TEXT PRIMARY KEY,
	at TEXT NOT NULL,
	group_label TEXT NOT NULL,
	sender_peer TEXT NOT NULL,
	sender_session TEXT,
	sender_name TEXT NOT NULL,
	recipient_peer TEXT NOT NULL,
	recipient_session TEXT,
	recipient_name TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('notice', 'request', 'reply')),
	in_reply_to TEXT,
	state TEXT NOT NULL,
	state_at TEXT NOT NULL,
	body TEXT NOT NULL
);
CREATE INDEX message_log_at ON message_log(at);
CREATE INDEX message_log_reply ON message_log(in_reply_to);
```

- `types.ts`: `MessageLogKind = "notice" | "request" | "reply"`; `MessageLogEntry = { id; at; groupLabel; senderPeer; senderSession: string | null; senderName; recipientPeer; recipientSession: string | null; recipientName; kind: MessageLogKind; inReplyTo: string | null; state: string; stateAt: string; body: string }`. `OPEN_MESSAGE_STATES = ["queued", "attempted"]`.
- `WorkStore` methods:
  - `logMessage(entry: Omit<MessageLogEntry, "stateAt"> & { stateAt?: string }): void`: `INSERT OR IGNORE` (the message id is the key; a retried send logs once). `stateAt` defaults to `at`.
  - `setMessageStates(updates: readonly { id: string; state: string; at: string }[]): number`: updates rows whose state differs; returns the count.
  - `openMessageIds(): string[]`: ids whose state is in `OPEN_MESSAGE_STATES`.
  - `listMessageLog(filter: { since?: string; peer?: string; limit?: number } = {}): MessageLogEntry[]`: newest first. `since` is an ISO time (inclusive). `peer` matches, case-insensitively, a sender or recipient name containing it, or a sender or recipient session id starting with it.
  - `messageThread(id: string): { message: MessageLogEntry; request: MessageLogEntry | null; replies: MessageLogEntry[] } | undefined`: the message, the request it answers (`in_reply_to`), and replies to it.
  - `pruneMessageLog(before: string): number`: deletes rows with `at < before`.
- `config.ts`: `MessagingConfig = { autoJoin: boolean; sendsPerHour: number; paused: boolean | string[]; retentionDays: number; routeCooldownMinutes: number }`, `DEFAULT_MESSAGING`, `messagingConfig(config: WorkConfig): MessagingConfig`, `parseMessaging(value, warnings)`, and `WorkConfig.messaging?: MessagingConfig` parsed from `data.messaging`.
- `src/work/messages.ts`: `parseSince(value: string): number` (milliseconds; `30m`, `2h`, `7d`; plain digits are hours; otherwise `UsageError`-style throw), `messageStateLabel(state)` (`queued`→`queued`, `attempted`→`delivering`, `observed`→`delivered`, `terminal-unresolved`→`unconfirmed`, others unchanged), `formatMessageLog(entries, now)`: per entry a header line `YYYY-MM-DD HH:MM  <sender> -> <recipient>  <kind>  <state label>` (plus `  re <first 8 chars of in_reply_to>` for replies), then the body indented by four spaces, with a blank line between entries; oldest first in the output. Control characters other than newline and tab are shown escaped.
- CLI `messages [--peer <name>] [--since <age>]` (default since `24h`): prunes rows older than `retentionDays`, then prints `formatMessageLog`, or `No messages since <ISO time>.`. It refuses with exit code 1 and the message `work messages is for the user; agents cannot read message bodies.` when `deps.env.PI_CODING_AGENT` is set (Pi sets it for every agent shell command).

## Task B: messaging policy and backend

Files: `src/messaging/contracts.ts`, `src/messaging/policy.ts`, `src/messaging/nats-backend.ts`. Ledger stays version 3; the new fields are optional, so older releases keep reading the ledger.

- `Group.auto?: boolean`. `createGroup(s, label, options?: { auto?: boolean })`: an `auto` request marks a new or existing group `auto: true`. Validation accepts `auto` only as a boolean. Auto groups are created with `mode: 'paused', limit: 0, used: 0` and never use the shared allowance; validation tolerates counters an older release's `arm` writes.
- Per-session budget: `StoredPeer.credits?: number; creditsAt?: number` (also exposed by `publicPeer`). `peerCredits(peer, sendsPerHour, now)`: `cap = sendsPerHour`; undefined credits means `cap`; otherwise `min(cap, credits + (now - creditsAt) * sendsPerHour / 3_600_000)`. `prepareMessage(s, lease, input, key, now, options?: { sendsPerHour?: number })`: in an auto group, notices and requests cost 1 and replies 0; with less than the cost available it fails `allowance` with `Messaging budget spent (<n> sends per hour); the next send is possible in about <m> minute(s)`; otherwise it stores the reduced credits and `creditsAt = now`. The shared-allowance check is skipped in auto groups. Every other check (routes, reverse traffic, open conversation, one unresolved outbound, 8 queued per recipient, store bounds) is unchanged. `sendsPerHour` defaults to 10 and must be an integer from 1 to 1000.
- Admission in auto groups (`canReceive`, `admitBatch`): no shared-allowance checks and no `used` increment; a recipient with an attempted message still receives nothing. Reservations keep `round = group.round`.
- Route cooldown: in auto groups every protocol closure (reverse route after a notice; both routes after a reply; routes closed by request expiry in `maintain`; a canceled or dismissed request in `resolveMessage`) records `closedAt: now` on the closed route. `maintain(s, now, options?: { routeCooldownMs?: number })` (default 10 minutes) reopens closed routes in auto groups whose `closedAt + routeCooldownMs <= now` (mode `open`, `closedAt` removed). Human `setRoute` writes no `closedAt`, so human closures stay. Validation accepts `closedAt` only as a finite number on a `closed` route.
- An auto group allows 32 active peers (other groups keep 16).
- `GroupSummary.auto: boolean`.
- Backend: `createGroup(label, options?)`, `send(input, requestKey, options?: { sendsPerHour?: number })`, `maintain(ref, now?, options?: { routeCooldownMs?: number })` pass these through; `heartbeat` keeps its own `policy.maintain(state)` with defaults.

## Task C: dashboard Messages section

Files: `src/work/dash/model.ts`, `view.ts`, `app.ts`. A `messages` section titled `Messages` after Jobs, with rows `{ kind: "message"; key: "message:<id>"; message: MessageLogEntry }` from `store.listMessageLog({ since: now - 24h, limit: 20 })`, newest first. A row shows time (`HH:MM`), `sender → recipient`, kind, and the first non-empty line of the body (sanitized). The `/` filter matches names, kind, and body. Enter opens a read-only message box with the message header and full body, followed by its request (for a reply) or its replies (for a request). Help text and README mention it.

## Task D: messaging extension

Files: `extensions/messaging.ts`, `src/messaging/*.ts` (not policy/backend semantics), new `src/messaging/host.ts`.

- `registerMessaging(pi, factory, ensure, options = {})`; omitted options are inert (no auto-join, no registry, no audit), so tests never touch live state. The default export passes live options: settings from the work config, names and liveness from the work registry, and the audit log in `work.db`.
- Auto-join: on `session_start` of a top-level TUI session with a saved session file (not a child: `PI_WORK_CHILD_RUN` or `PI_WORK_PARENT_SESSION` set), when `autoJoin` is on, ensure the broker, connect, `createGroup('host', { auto: true })`, then resume this session's own suspended or stale peer, or join with the registry display name. Failures notify once and leave messaging off. After tree navigation (`session_tree`), rejoin the same way. On `session_shutdown` with reason `reload`, suspend; otherwise leave. Children never join and do not get the `peer_message` tool.
- Names: from the registry (`sessionDisplayName(tmuxWindow, repo, cwd)`), refreshed on heartbeat via `backend.heartbeat(name)` when it changes; fall back to the cwd basename. The `rename` action is removed from `peer_message` and its guidance.
- Presence: `peers` reports registry liveness: a peer whose registry session is not live is `offline`. About once a minute, peers in the host group that are not online and whose registry session is closed or crashed are revoked.
- Pause: `paused` from the config (re-read on heartbeat) and `/messages pause` / `/messages resume` (this session, in memory) stop sends (`peer_message` send fails with `Messaging is paused by the user`) and deliveries.
- Budget: `send` passes `sendsPerHour`; maintenance passes `routeCooldownMs`. The status line shows `messages <name>: <n>/<cap> sends left, <q> queued` or `messages <name>: paused`.
- Audit: every accepted send (tool or `/messages`) is logged with the body; on heartbeat, open rows are updated from `listMessages` states; rows older than `retentionDays` are pruned at join and hourly. No tool returns bodies.
- Existing `/messages` subcommands keep working for manual groups; `arm` is not needed for the host group.

### Task D details

- Options (`src/messaging/host.ts` exports the types and `liveMessagingOptions()`):

```ts
export interface MessagingSettings { autoJoin: boolean; sendsPerHour: number; paused: boolean | string[]; retentionDays: number; routeCooldownMinutes: number }
export type RegistryLiveness = 'live' | 'ended' | 'unknown';
export interface MessagingRegistry { displayName(sessionId: string, cwd: string): string | undefined; liveness(sessionId: string): RegistryLiveness }
export interface MessagingAudit { record(entry: MessageLogEntry): void; openIds(): string[]; setStates(updates: { id: string; state: string; at: string }[]): void; prune(before: string): void }
export interface MessagingOptions { settings?: () => MessagingSettings; registry?: MessagingRegistry; audit?: MessagingAudit; env?: NodeJS.ProcessEnv }
```

  Omitted options are inert: settings `{ autoJoin: false, sendsPerHour: 10, paused: false, retentionDays: 30, routeCooldownMinutes: 10 }`, no registry (names fall back to the cwd basename, presence is heartbeat-only), no audit, and `env = {}`. Tests (and child agents running them, whose real environment has `PI_WORK_CHILD_RUN`) therefore never see live state. `liveMessagingOptions()` reads `messagingConfig(loadWorkConfig().config)` (re-read at most every 5 seconds), opens `WorkStore` at `join(defaultDataDir(), 'work.db')` lazily, derives names with `sessionDisplayName(session.tmuxWindow, repoFromCwd(cwd), cwd)` (repo cached per cwd; result trimmed to a valid display name of at most 64 characters), liveness with `pidAlive(session.pid, session.tmuxPane)` (`live`), a known but dead session (`ended`), or no row (`unknown`), and passes `env: process.env`. Every registry or audit failure is caught; messaging keeps working without it.
- The default export is `pi => registerMessaging(pi, configuredBackend, () => ensureBroker(), liveMessagingOptions())`.
- Wrap the connected backend once so every caller (tool, `/messages` UI, runtime) passes `{ sendsPerHour }` to `send` and `{ routeCooldownMs }` to `maintain`, and so every accepted send is recorded in the audit log (sender and recipient names and session ids from `peers()`; the group label; `state` from the returned status; `at` from `createdAt`).
- The runtime heartbeat (every 5 s) also runs a best-effort extension tick: re-read settings and pause state (wake on resume), refresh the display name (`heartbeat(name)` only when it changed), sync open audit rows from `listMessages` states, prune audit rows older than `retentionDays` hourly, and about once a minute revoke host-group peers that are not online and whose registry liveness is `ended`. Tick failures never stop messaging.
- `ready()` is false while paused, so nothing is reserved; sends while paused fail with `fail('paused', 'Messaging is paused by the user')`.
- `peer_message` without participation fails with `Messaging is not active in this session`. Results never contain bodies. `status` adds `budget: { left, perHour }` (left floored) for auto groups. `peers` presence is `offline` when registry liveness is `ended`.
- The tool schema drops `rename` and `displayName`; guidance drops the rename sentence and the words "explicitly joined"; descriptions stay static strings (cache stability). Update the affected extension, quiet, and cache-stability tests and `scripts/messaging-live-smoke.mjs` (drop rename assertions; join via auto-join options).
