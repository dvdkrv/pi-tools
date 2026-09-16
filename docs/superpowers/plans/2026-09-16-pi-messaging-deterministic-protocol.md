# Pi Messaging Deterministic Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build ledger v3 with stable member takeover, bounded lifecycle/message retention, and an enforceable finite notice/request/reply protocol without dynamic Pi prompt or tool mutation.

**Architecture:** Keep NATS JetStream bodies and a CAS-controlled KV ledger, but separate stable member identity, directional route state, transport state, and request outcome. Add pure deterministic policy transitions first, then integrate migration/maintenance into the backend, expose static agent metadata and human-only controls, and preserve idle-boundary delivery.

**Tech Stack:** TypeScript 7, Node.js 22.19+, Pi extension API, TypeBox, NATS JetStream/KV 3.4.0, Node test runner, Jiti.

## Global Constraints

- Work only in the isolated `feat/messaging-protocol-v3` worktree.
- Do not dispatch subagents; execution and review are inline.
- Do not connect to or mutate the live broker, ledger, groups, members, messages, allowance, configuration, or installed package.
- Tests use only pure fixtures, temporary homes, scripted Pi contexts, and disposable authenticated NATS brokers.
- Broker startup never joins, arms, sends, delivers, expires state, reads bodies, or invokes a model.
- Humans exclusively control participation, member creation/takeover, route reopening, allowance, recovery, revocation, and rollout.
- Suspended/stale members expire after exactly 24 hours; queued messages after exactly 1 hour; attempted-unconfirmed messages after exactly 10 minutes; delivered reply capabilities after exactly 1 hour; terminal history after exactly 7 days.
- Attempted admissions are never replayed or refunded.
- Requests reserve two allowance slots atomically; replies consume the request's reserved slot.
- New sends require an explicit `notice`, `request`, or `reply` kind; migrated records alone may use `legacy`.
- `peer_message` remains one statically registered tool. Its set, schema, description, snippet, and prompt guidance never change within a Pi process.
- Heartbeat and maintenance append no conversation messages and perform no model work.
- Commits are SSH-signed with the repository-local `dvdkrv` identity. Do not tag, publish, update dotfiles, or touch live sessions without a later explicit human rollout decision.

---

## File Structure

### New files

- `src/messaging/ledger.ts` — exact v1/v2/v3 validation, lossless migration, v3 construction, and ledger types.
- `src/messaging/validation.ts` — bounded text/name/input validation, safe rendering, timestamp checks, and payload hashes shared by ledger and policy.

### Modified source files

- `src/messaging/contracts.ts` — public/member/message/route DTOs and backend interfaces.
- `src/messaging/policy.ts` — pure membership, route, protocol, allowance, receipt, recovery, expiry, and pruning transitions; re-export ledger/validation compatibility symbols.
- `src/messaging/nats-backend.ts` — migration exposure, stable takeover, protocol publication, deadline-safe admission, and ledger-first transport cleanup.
- `src/messaging/runtime.ts` — stationary protocol delivery blocks and exact receipt handling.
- `src/messaging/tool-input.ts` — static required send-kind schema and normalization.
- `src/messaging/identity.ts` — static notice/request/reply guidance.
- `src/messaging/ui.ts` — takeover, message-kind choice, route controls, separated status, and recovery UI.
- `src/messaging/completions.ts` — `routes` completion and revised descriptions.
- `extensions/messaging.ts` — static agent API projection, route metadata, and cache-stable registration.
- `src/messaging/public.ts` — updated exported metadata types only; remains read-only.
- `README.md` — protocol, expiry, lifecycle, and rollout documentation.

### Modified tests and helpers

- `tests/messaging/policy.test.mjs` — pure v3 protocol and deadline invariants.
- `tests/messaging/backend.test.mjs` — migration, takeover, exact protocol, maintenance, and durable preservation.
- `tests/messaging/failures.test.mjs` — CAS races, stale leases, deadline races, and cleanup failures.
- `tests/messaging/runtime.test.mjs` — stationary delivery blocks and request observation.
- `tests/messaging/extension.test.mjs` — static tool API, human-only routes/takeover, hidden historical members, and cache stability.
- `tests/messaging/quiet.test.mjs`, `tests/messaging/coexistence.test.mjs`, `tests/messaging/cache-stability.test.mjs` — required-kind fixtures and unchanged quiet/cache behavior.
- `tests/messaging/helpers/contender.mjs`, `tests/messaging/helpers/lease-contender.mjs` — explicit message kinds and takeover/concurrency actions.
- `scripts/messaging-live-smoke.mjs` — explicit safe protocol kinds; not run against live state during implementation.

---

### Task 1: Introduce v3 contracts and exact migration

**Files:**
- Create: `src/messaging/validation.ts`
- Create: `src/messaging/ledger.ts`
- Modify: `src/messaging/contracts.ts`
- Modify: `src/messaging/policy.ts`
- Test: `tests/messaging/policy.test.mjs`
- Test: `tests/messaging/backend.test.mjs`

**Interfaces:**
- Produces `LedgerV3`, exported as `Ledger`, with `version: 3`, `routes`, stable peer/member lifecycle fields, and protocol message fields.
- Produces `newLedger(authorityId)`, `validateLedger(value, authorityId)`, and `migrateLedger(value, authorityId, now?)` from `ledger.ts`, re-exported by `policy.ts`.
- Produces `MessageKind`, `ConversationState`, `RouteMode`, `Route`, and expanded `MessageStatus`/`GroupSummary` contracts.
- Produces shared `safeText`, `validateDisplayName`, `validateInput`, `payloadHash`, and `lifecycleTime` from `validation.ts`, re-exported by `policy.ts` where existing callers require compatibility.

- [ ] **Step 1: Replace migration tests with failing literal v1/v2/v3 expectations**

Add assertions equivalent to:

```js
const migrated = p.migrateLedger(literalV2, authorityId, 50_000).ledger;
assert.equal(migrated.version, 3);
assert.deepEqual(Object.keys(migrated.routes).sort(), [
  p.routeKey(senderId, recipientId),
  p.routeKey(recipientId, senderId),
]);
assert.ok(Object.values(migrated.messages).every(message => message.kind === 'legacy'));
assert.equal(p.migrateLedger(migrated, authorityId).migrated, false);
```

Retain a literal v1 fixture and assert direct one-CAS v1-to-v3 field preservation. Add corruption cases for missing routes, malformed route keys, inconsistent conversation fields, invalid lifecycle timestamps, and public lease leakage.

- [ ] **Step 2: Run focused tests and verify the expected v2 assertions fail**

Run:

```bash
node --test --test-name-pattern='migration|ledger versions|validators' tests/messaging/policy.test.mjs tests/messaging/backend.test.mjs
```

Expected: FAIL because the current ledger is version 2 and has no routes/kinds.

- [ ] **Step 3: Define the v3 public and private contracts**

Use explicit unions, including:

```ts
export type MessageKind = 'legacy' | 'notice' | 'request' | 'reply';
export type MessageState = 'queued' | 'attempted' | 'observed' | 'canceled' | 'dismissed' | 'expired' | 'terminal-unresolved';
export type ConversationState = 'pending-delivery' | 'awaiting-reply' | 'reply-pending' | 'answered' | 'unanswered';
export type RouteMode = 'open' | 'closed' | 'reply-only';
export interface Route {
  groupId: string;
  fromPeerId: string;
  toPeerId: string;
  mode: RouteMode;
  requestMessageId?: string;
  observedAt?: number;
  expiresAt?: number;
}
```

Retain `Peer` naming in public TypeScript APIs to avoid an unrelated package-level rename, but add `suspendedAt`, `endedAt`, and `endReason`. Treat its `id` as the stable member ID.

- [ ] **Step 4: Extract validation and implement exact v1/v2/v3 validation/migration**

`migrateLedger` must:

- clone rather than mutate v1/v2 input;
- create v3 open routes for both directions between every current member pair in the same group;
- map old messages to `kind: 'legacy'` without changing hashes, IDs, ordering, attempts, or counters;
- derive `suspendedAt` from `lastSeen` for old suspended peers;
- mark old inactive peers with a bounded terminal lifecycle representation;
- return an existing exact v3 object unchanged;
- reject all unknown versions and inconsistent optional fields.

New v3 payload hashes include `kind`; legacy hashes retain the exact old input projection.

- [ ] **Step 5: Run migration tests and typecheck**

Run:

```bash
node --test --test-name-pattern='migration|ledger versions|validators' tests/messaging/policy.test.mjs tests/messaging/backend.test.mjs
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit the v3 schema foundation**

```bash
git add src/messaging/contracts.ts src/messaging/validation.ts src/messaging/ledger.ts src/messaging/policy.ts tests/messaging/policy.test.mjs tests/messaging/backend.test.mjs
git commit -S -m "feat: define messaging ledger v3"
```

---

### Task 2: Implement stable membership, routes, and human-confirmed takeover policy

**Files:**
- Modify: `src/messaging/policy.ts`
- Modify: `src/messaging/contracts.ts`
- Test: `tests/messaging/policy.test.mjs`

**Interfaces:**
- Produces `routeKey(fromPeerId, toPeerId): string` and `routesForPeer(state, peerId): Route[]`.
- Produces `takeoverPeer(state, ref, newSessionId, peerId, now?): StoredPeer`.
- Extends `joinPeer`, `resumePeer`, `suspendPeer`, `leavePeer`, and `revokePeer` with route/lifecycle invariants.
- Produces `setRoute(state, ref, fromPeerId, toPeerId, mode, recoverReplyOnly, now?)` for human-only backend calls.

- [ ] **Step 1: Write failing pure lifecycle and route tests**

Cover:

```js
const beforeCount = Object.keys(state.peers).length;
p.heartbeat(state, p.leaseOf(member), 'renamed');
assert.equal(Object.keys(state.peers).length, beforeCount);
assert.equal(state.peers[member.id].id, member.id);

p.suspendPeer(state, p.leaseOf(member), 1_000);
const replacement = p.takeoverPeer(state, group, 'new-session', member.id, 2_000);
assert.equal(replacement.id, member.id);
assert.equal(replacement.sessionId, 'new-session');
assert.notEqual(replacement.leaseId, oldLease.leaseId);

assert.equal(p.routeOf(state, a.id, b.id).mode, 'open');
assert.equal(p.routeOf(state, b.id, a.id).mode, 'open');
```

Also assert online takeover rejection, same-session resume preservation, route removal on final leave, and old-lease fencing after takeover.

- [ ] **Step 2: Run lifecycle-focused tests and verify failure**

Run:

```bash
node --test --test-name-pattern='rename|takeover|resume|suspend|route|membership' tests/messaging/policy.test.mjs
```

Expected: FAIL because takeover and route lifecycle do not exist.

- [ ] **Step 3: Implement stable member lifecycle transitions**

Use explicit `now` arguments for all lifecycle mutations. `suspendPeer` records `suspendedAt`; heartbeat clears no lifecycle state and only updates a current lease. `takeoverPeer` accepts stale or suspended current members, rejects online/left members, changes `sessionId`, rotates the lease, and preserves ID/name/routes/history.

`joinPeer` creates both open directions with every current member. Leave/revoke set `endedAt`/`endReason`, rotate the lease, and delete routes involving the finalized member.

- [ ] **Step 4: Implement guarded human route mutation**

Opening/closing requires two current same-group members. Ordinary editing rejects a `reply-only` route. `recoverReplyOnly: true` first terminalizes its request as unanswered and releases only its unused reservation, then applies the requested mode.

- [ ] **Step 5: Run lifecycle policy tests**

Run:

```bash
node --test --test-name-pattern='rename|takeover|resume|suspend|route|membership' tests/messaging/policy.test.mjs
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit stable membership policy**

```bash
git add src/messaging/contracts.ts src/messaging/policy.ts tests/messaging/policy.test.mjs
git commit -S -m "feat: add stable messaging members and routes"
```

---

### Task 3: Implement finite notice/request/reply policy and weighted allowance

**Files:**
- Modify: `src/messaging/policy.ts`
- Modify: `src/messaging/contracts.ts`
- Test: `tests/messaging/policy.test.mjs`
- Modify: `tests/messaging/helpers/contender.mjs`
- Modify: `tests/messaging/helpers/lease-contender.mjs`

**Interfaces:**
- `SendInput` becomes `{ kind: 'notice' | 'request' | 'reply'; toPeerId: string; text: string; inReplyTo?: string }`.
- Produces `reservedSlots(state, groupId): number` and enforces `used + reservedSlots <= limit`.
- `prepareMessage` atomically validates route/conversation state and performs reverse-route transitions.
- `observeBatch` starts request reply deadlines and completes request outcome when a reply is observed.

- [ ] **Step 1: Update test helpers to require explicit message kinds**

Change generic send helpers to default intentionally to notices:

```js
function send(f, key = randomUUID(), text = 'hello', kind = 'notice') {
  return p.prepareMessage(f.state, lease(f.a), { kind, toPeerId: f.b.id, text }, key);
}
```

Use `request` only in request/reply tests and `reply` only with `inReplyTo`.

- [ ] **Step 2: Write failing protocol and accounting tests**

Test all of these independently:

- notice closes only the reverse route;
- pending reverse traffic makes a notice fail without mutation;
- opposite concurrent logical sends have only one valid ordering;
- request requires two available slots;
- request admission spends one and retains one reserved reply slot;
- unrelated traffic cannot consume the reserved slot;
- only exact observed request recipient can reply to exact sender;
- duplicate, nested, third-party, wrong-recipient, unobserved, and late replies fail;
- reply queueing transfers the reservation and closes both directions;
- reply observation marks the request answered;
- arming below weighted reservations fails;
- idempotent retries return the original record before re-evaluating now-closed routes.

- [ ] **Step 3: Run protocol tests and verify failure**

Run:

```bash
node --test --test-name-pattern='notice|request|reply|reservation|route' tests/messaging/policy.test.mjs
```

Expected: FAIL because sends lack explicit protocol enforcement.

- [ ] **Step 4: Implement message validation and route transitions**

Implement these exact transitions:

```text
notice A->B: require A->B open and reverse-clear; set B->A closed
request A->B: require A->B open and reverse-clear; reserve 2; set B->A reply-only(request)
reply B->A: require exact observed request capability; transfer reserved slot to reply; close B->A and A->B
```

A pair may have only one open request conversation. Keep the current one-unresolved-outbound-per-sender rule.

- [ ] **Step 5: Implement weighted accounting and summaries**

Compute reservations from authoritative message/conversation states rather than maintaining a second mutable counter. Extend summaries with `queuedCount`, `attemptedCount`, `awaitingReplyCount`, `terminalUnresolvedCount`, and `reservedCount`, while retaining `pendingCount` for read-only compatibility.

`admitBatch` spends one credit per admitted body and must refuse any selection that would violate reserved reply capacity.

- [ ] **Step 6: Run the full policy suite and typecheck**

Run:

```bash
node --test tests/messaging/policy.test.mjs
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit the finite protocol**

```bash
git add src/messaging/contracts.ts src/messaging/policy.ts tests/messaging/policy.test.mjs tests/messaging/helpers/contender.mjs tests/messaging/helpers/lease-contender.mjs
git commit -S -m "feat: enforce finite peer message exchanges"
```

---

### Task 4: Add deterministic expiry and retention policy

**Files:**
- Modify: `src/messaging/policy.ts`
- Modify: `src/messaging/contracts.ts`
- Test: `tests/messaging/policy.test.mjs`

**Interfaces:**
- Exports `MEMBER_TTL_MS`, `QUEUED_TTL_MS`, `ATTEMPT_TTL_MS`, `REPLY_TTL_MS`, and `HISTORY_TTL_MS` with exact values from the spec.
- Produces `maintain(state, now): MaintenanceResult` and `prunable(state, ref, now): string[]`.
- Produces deadline-aware admission predicates so expired work cannot be admitted even before transport cleanup.

- [ ] **Step 1: Write failing exact-boundary tests with explicit clocks**

Use `deadline - 1` and `deadline` assertions for every deadline. Cover queued notice/request/reply, attempted notice/request/reply, delivered unanswered request, suspended member, crashed stale member, and seven-day terminal retention.

Include accounting assertions such as:

```js
p.maintain(state, request.createdAt + p.QUEUED_TTL_MS);
assert.equal(state.messages[request.id].state, 'expired');
assert.equal(p.reservedSlots(state, group.id), 0);
assert.equal(state.groups[group.id].used, 0);
```

For attempted expiry, assert `used` is unchanged.

- [ ] **Step 2: Run maintenance tests and verify failure**

Run:

```bash
node --test --test-name-pattern='expire|expiry|deadline|retention|maintenance|unanswered' tests/messaging/policy.test.mjs
```

Expected: FAIL because no automatic terminalization exists.

- [ ] **Step 3: Implement pure maintenance transitions**

Order transitions deterministically by sequence/member ID. Finalizing a member immediately terminalizes all queued/attempted/open-request work involving it per the spec and removes its routes. Request/reply linked records must be updated together.

Maintenance must never increment allowance, decrement `used`, reopen a route, change a body, or issue I/O.

- [ ] **Step 4: Make admission deadline-safe**

`canReceive` and `admitBatch` must run/validate maintenance at the supplied `now` before selecting queued candidates. Expired metadata cannot become attempted merely because transport cleanup has not run.

- [ ] **Step 5: Run full policy tests and typecheck**

Run:

```bash
node --test tests/messaging/policy.test.mjs
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit bounded lifecycle policy**

```bash
git add src/messaging/contracts.ts src/messaging/policy.ts tests/messaging/policy.test.mjs
git commit -S -m "feat: bound messaging lifecycle and retention"
```

---

### Task 5: Integrate v3, takeover, and cleanup with the NATS backend

**Files:**
- Modify: `src/messaging/nats-backend.ts`
- Modify: `src/messaging/contracts.ts`
- Modify: `src/messaging/public.ts`
- Test: `tests/messaging/backend.test.mjs`
- Test: `tests/messaging/failures.test.mjs`

**Interfaces:**
- Adds backend `takeover(ref, peerId, newSessionId)`, `routes(ref)`, `setRoute(...)`, and `maintain(ref, now?)` methods.
- Keeps `resume(ref, peerId, sameSessionId)` for same-session attachment.
- Publishes v2 envelopes for new protocol messages and validates v1 envelopes only for migrated legacy records.
- Maintenance commits ledger terminalization before purging bodies/consumers, then conditionally deletes still-eligible metadata.

- [ ] **Step 1: Write failing isolated-broker migration and takeover tests**

Assert:

- literal v1 and v2 each become v3 in exactly one KV revision;
- a concurrent valid v3 migration winner is accepted;
- takeover preserves the durable consumer creation timestamp and queued inbox;
- takeover rotates the lease and old process operations fail;
- an online or finalized member cannot be taken over;
- public peers contain no lease.

- [ ] **Step 2: Write failing cleanup and protocol integration tests**

Cover:

- request reserves two credits across real connections;
- exact reply uses the reserved credit;
- notice blocks a fresh reverse notice;
- queued expiry releases reservation and its body is later purged;
- attempted expiry keeps `used` and is never redelivered;
- member expiry removes its consumer and hides it from current peers;
- terminal metadata survives until seven days and then prunes regardless of sender activity;
- purge failure leaves terminal metadata inaccessible and succeeds on later maintenance.

- [ ] **Step 3: Run focused broker tests and verify failure**

Run:

```bash
PI_MESSAGING_REQUIRE_BROKER=1 node --test --test-name-pattern='migrat|takeover|request|reply|notice|maintenance|expire|prune' tests/messaging/backend.test.mjs tests/messaging/failures.test.mjs
```

Expected: FAIL on missing backend methods and v3 behavior.

- [ ] **Step 4: Implement backend v3 participation and publication**

Mirror existing join/resume bind-before-commit cleanup safeguards for takeover. Preserve exact membership-generation fencing around asynchronous consumer binding.

Build envelopes from the committed message kind. An idempotent retry of attempted or terminal work never republishes. Publication uncertainty keeps authoritative metadata and fails closed.

- [ ] **Step 5: Implement ledger-first maintenance and idempotent transport cleanup**

Perform state transitions through `change`. Purge only bodies named by a committed eligible snapshot. Enumerate consumers, reread state, and delete only consumers whose members remain finalized. Delete metadata in a second CAS only when it is still old and dependency-free.

Throttle transport enumeration to at most once per minute, but run pure deadline checks in send/admission CAS paths so no expired work can be admitted.

- [ ] **Step 6: Run complete backend/failure suites and typecheck**

Run:

```bash
PI_MESSAGING_REQUIRE_BROKER=1 node --test tests/messaging/backend.test.mjs tests/messaging/failures.test.mjs
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit backend integration**

```bash
git add src/messaging/contracts.ts src/messaging/nats-backend.ts src/messaging/public.ts tests/messaging/backend.test.mjs tests/messaging/failures.test.mjs
git commit -S -m "feat: integrate deterministic messaging backend"
```

---

### Task 6: Make runtime delivery protocol-aware and stationary

**Files:**
- Modify: `src/messaging/runtime.ts`
- Test: `tests/messaging/runtime.test.mjs`
- Test: `tests/messaging/quiet.test.mjs`
- Test: `tests/messaging/cache-stability.test.mjs`

**Interfaces:**
- Keeps `CUSTOM_TYPE` and one batch-shaped custom message.
- Adds stable per-message fields `kind`, `messageId`, sender IDs/name, reply directive, and fixed reply-window duration. Exact deadlines are returned only after observation through metadata APIs.
- Receipt correlation remains exact and calls one `observe` batch.

- [ ] **Step 1: Write failing stationary-wrapper tests**

Create notice, request, and reply reservations and assert exact ordered block labels/directives. Assert hostile bodies remain JSON strings and cannot forge delimiters.

Capture the rendered wrapper template across repeated deliveries and verify field labels/order are constant even as values differ.

- [ ] **Step 2: Write failing cache-silence tests**

Exercise heartbeat/maintenance through runtime and assert no `deliver` call. Confirm only a nonempty admitted batch invokes `deliver`, always with `{ triggerTurn: true, deliverAs: 'followUp' }`.

- [ ] **Step 3: Run runtime tests and verify failure**

Run:

```bash
node --test tests/messaging/runtime.test.mjs tests/messaging/quiet.test.mjs tests/messaging/cache-stability.test.mjs
```

Expected: FAIL because delivery lacks kinds and directives.

- [ ] **Step 4: Implement one stable protocol delivery formatter**

Do not generate dynamic tool/system instructions. Use fixed labels and fixed ordering; vary only escaped metadata/body values. A request directive names the exact message ID and states that the one-hour window begins when delivery observation commits; it must not invent a pre-observation timestamp. A notice says reverse traffic is forbidden, and a reply says acknowledgement is forbidden.

- [ ] **Step 5: Run runtime tests and typecheck**

Run:

```bash
node --test tests/messaging/runtime.test.mjs tests/messaging/quiet.test.mjs tests/messaging/cache-stability.test.mjs
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit stationary protocol delivery**

```bash
git add src/messaging/runtime.ts tests/messaging/runtime.test.mjs tests/messaging/quiet.test.mjs tests/messaging/cache-stability.test.mjs
git commit -S -m "feat: deliver structured peer messages"
```

---

### Task 7: Update the static agent API without cache churn

**Files:**
- Modify: `src/messaging/tool-input.ts`
- Modify: `src/messaging/identity.ts`
- Modify: `extensions/messaging.ts`
- Test: `tests/messaging/extension.test.mjs`
- Test: `tests/messaging/cache-stability.test.mjs`
- Test: `tests/messaging/coexistence.test.mjs`

**Interfaces:**
- Adds static `kind` enum to `peerMessageParameters`.
- `send` requires `kind`; `reply` requires `inReplyTo`; notice/request forbid it.
- `peers` projects caller-specific `sendMode`, request ID, and deadline from backend routes.
- `status` projects only bounded outgoing metadata and separated state/outcome fields.

- [ ] **Step 1: Write failing schema and validation tests**

Assert the real Pi argument pipeline accepts:

```js
{ action: 'send', kind: 'notice', toPeerId, text: 'status only' }
{ action: 'send', kind: 'request', toPeerId, text: 'review this' }
{ action: 'send', kind: 'reply', toPeerId, text: 'done', inReplyTo: requestId }
```

Reject missing/unknown kinds, reply without reference, notice/request with reference, and meaningful kind padding on non-send actions.

- [ ] **Step 2: Write a registration identity/cache regression**

Capture at registration:

```js
const baseline = {
  names: [...tools.keys()],
  schemaObject: tool.parameters,
  schemaJson: JSON.stringify(tool.parameters),
  promptJson: JSON.stringify({
    description: tool.description,
    promptSnippet: tool.promptSnippet,
    promptGuidelines: tool.promptGuidelines,
  }),
};
```

After rename, peers, status, send, route changes, maintenance, suspend, resume, and takeover, assert the same schema object identity, serialized schema, tool names, and prompt metadata. Assert no context hook and no maintenance `sendMessage` call.

- [ ] **Step 3: Run extension/cache tests and verify failure**

Run:

```bash
node --test --test-name-pattern='argument|schema|guidance|cache|stationary|identity|peers|status' tests/messaging/extension.test.mjs tests/messaging/cache-stability.test.mjs tests/messaging/coexistence.test.mjs
```

Expected: FAIL because `kind` and route projections do not exist.

- [ ] **Step 4: Implement static schema, normalization, and tool execution**

Keep all registration constants module-static. Do not recreate or modify schemas after registration. Normalize only neutral null/empty padding; never discard a meaningful kind or reply reference.

Return queue receipt wording appropriate to kind. Do not imply that a request reply is guaranteed, and do not encourage polling.

- [ ] **Step 5: Update static guidance**

State that notices forbid reverse traffic, requests permit one exact reply, replies must cite the request, and agents must not disguise a response as a new message. Guidance contains no current IDs, names, deadlines, route states, or allowance.

- [ ] **Step 6: Run extension/cache/coexistence suites and typecheck**

Run:

```bash
node --test tests/messaging/extension.test.mjs tests/messaging/cache-stability.test.mjs tests/messaging/coexistence.test.mjs
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit cache-stable agent API changes**

```bash
git add src/messaging/tool-input.ts src/messaging/identity.ts extensions/messaging.ts tests/messaging/extension.test.mjs tests/messaging/cache-stability.test.mjs tests/messaging/coexistence.test.mjs
git commit -S -m "feat: expose static structured messaging API"
```

---

### Task 8: Add human takeover, route, and protocol controls

**Files:**
- Modify: `src/messaging/ui.ts`
- Modify: `src/messaging/completions.ts`
- Modify: `extensions/messaging.ts`
- Test: `tests/messaging/extension.test.mjs`

**Interfaces:**
- Adds `/messages routes`.
- Join flow distinguishes same-session resume from human-confirmed cross-session takeover.
- Human compose requires `notice` or `request`; a reply action appears only for an exact delivered open request.
- Status hides finalized tombstones and reports separated counts.

- [ ] **Step 1: Write failing completion and join/takeover UI tests**

Assert `routes` appears in completions. Build stale/suspended candidates from other session IDs, select one, confirm takeover, and assert stable ID/new session/rotated lease/no allowance change. Assert cancel and late-dialog session replacement mutate nothing.

- [ ] **Step 2: Write failing route and compose UI tests**

Assert:

- route inspection reads metadata only;
- ordinary reopening of reply-only is rejected;
- confirmed recovery marks the request unanswered before opening;
- opening grants no allowance;
- agent tool cannot call route controls;
- human compose always selects notice/request explicitly;
- inbox reply exists only for an observed request capability.

- [ ] **Step 3: Write failing member-list cleanup tests**

Create renamed, left, expired, and taken-over identities. Assert normal status lists one current logical member per ID, hides finalized tombstones, and never increases count on rename/takeover.

- [ ] **Step 4: Run UI tests and verify failure**

Run:

```bash
node --test --test-name-pattern='completion|takeover|routes|human composition|status shows|member' tests/messaging/extension.test.mjs
```

Expected: FAIL on missing UI behavior.

- [ ] **Step 5: Implement guarded UI flows**

Preserve `controls.guard()` around every asynchronous broker/UI boundary. Takeover confirmation names the group/member/current presence and explicitly says routing/inbox are preserved, the old lease is fenced, and no allowance is granted.

Route recovery uses a separate warning from ordinary open/close and states exactly which request becomes unanswered and that spent credits are not refunded.

- [ ] **Step 6: Run the full extension suite and typecheck**

Run:

```bash
node --test tests/messaging/extension.test.mjs
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit human controls**

```bash
git add src/messaging/ui.ts src/messaging/completions.ts extensions/messaging.ts tests/messaging/extension.test.mjs
git commit -S -m "feat: add human messaging route controls"
```

---

### Task 9: Reconcile all fixtures, smoke code, and documentation

**Files:**
- Modify: `tests/messaging/*.test.mjs`
- Modify: `tests/messaging/helpers/*.mjs`
- Modify: `scripts/messaging-live-smoke.mjs`
- Modify: `README.md`
- Modify: `tests/package.test.mjs`

**Interfaces:**
- No new runtime interfaces.
- Every new send in tests/scripts specifies intentional `kind`.
- Public documentation matches v3 but does not claim an unpublished tag contains it.

- [ ] **Step 1: Find all old untyped send sites**

Run:

```bash
rg -n '\.send\(\{|prepareMessage\([^\n]*\{' src extensions tests scripts
```

Classify every call as notice, request, or reply. Do not add an implicit compatibility default.

- [ ] **Step 2: Update remaining fixtures and scripted smoke inputs**

Use notices for one-way test traffic, requests only where a reply is exercised, and replies only with an exact observed request. Keep the live smoke script inert unless explicitly run; do not execute it during development.

- [ ] **Step 3: Update README and package assertions**

Document:

- stable member IDs and confirmed takeover;
- 24-hour member cleanup;
- notice/request/reply route semantics;
- exact expiry windows and seven-day retention;
- two-credit requests;
- human-only routes and recovery;
- static tool/cache behavior;
- forward-only migration and idle-boundary rollout.

Keep installation examples on the currently published immutable tag until a separate release task is approved.

- [ ] **Step 4: Run repository-wide tests and repair only feature-related failures**

Run:

```bash
PI_MESSAGING_REQUIRE_BROKER=1 npm test
npm run typecheck
npm run check
npm run test:install
git diff --check
```

Expected: all commands PASS. Do not use `npm audit fix` or unrelated dependency changes.

- [ ] **Step 5: Commit reconciliation and docs**

```bash
git add README.md scripts/messaging-live-smoke.mjs tests
git commit -S -m "docs: document deterministic messaging protocol"
```

---

### Task 10: Inline review and release-candidate verification

**Files:**
- Review only; modify feature files only for verified defects.

**Interfaces:**
- No new interfaces.

- [ ] **Step 1: Review the complete diff against the design**

Run:

```bash
git diff 46502ae7dab73593228ff3302efd8662dc34338a...HEAD --stat
git diff 46502ae7dab73593228ff3302efd8662dc34338a...HEAD -- src/messaging extensions/messaging.ts tests/messaging README.md
```

Check every design invariant, especially route races, weighted reservations, finalization, migration preservation, cleanup ordering, body secrecy, and cache stability.

- [ ] **Step 2: Verify no private or organization-specific material entered the public repository**

Run:

```bash
rg -n '/home/|DataDog|github-personal|ssh_auth_sock|NATS_TOKEN|leaseId.*JSON|stringify\(.*config' README.md docs src extensions tests scripts || true
npm run check
```

Expected: only intentional generic test/code references; no secrets, personal paths, private state, or company-specific examples.

- [ ] **Step 3: Run final clean verification**

Run:

```bash
PI_MESSAGING_REQUIRE_BROKER=1 npm test
npm run typecheck
npm run check
npm run test:install
git diff --check
git status --short
```

Expected: all tests/checks pass and the worktree is clean.

- [ ] **Step 4: Verify every feature commit signature**

Run:

```bash
git log --show-signature --format='%H %G? %s' 46502ae7dab73593228ff3302efd8662dc34338a..HEAD
```

Expected: each commit is trusted and signed by `David Kirov <31777857+dvdkrv@users.noreply.github.com>` with fingerprint `SHA256:YD5aofj7Ho7upNN2q7RI2R5mPJPQGKpO+91P4NkmARY`.

- [ ] **Step 5: Stop before publication or live rollout**

Report the branch, commits, verification evidence, migration impact, and remaining explicit human decisions. Do not merge, push, tag, publish, update dotfiles, apply the package, reload sessions, or touch live broker state without new approval.
