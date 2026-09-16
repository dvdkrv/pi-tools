# Pi Messaging Deterministic Protocol Design

**Date:** 2026-09-16  
**Repository:** `dvdkrv/pi-tools`  
**Status:** Approved design, pending implementation plan

## Purpose

Improve the Pi messaging extension in three related areas:

1. prevent channel membership from accumulating duplicate or historical entries after rename, session replacement, and departure;
2. ensure queued, uncertain, and unanswered work cannot remain pending forever;
3. replace free-form reply behavior with an enforceable finite protocol, including a real guarantee that a no-reply notice cannot receive reverse traffic from its recipient.

The implementation must preserve local-first operation, human-controlled participation and allowance, conservative no-replay/no-refund behavior, lifecycle fencing, metadata-only agent discovery, quiet idle-boundary delivery, and stable provider prompt-cache prefixes.

## Non-goals

- Inferring semantic intent from message text.
- Allowing agents to join groups, create members, take over identities, reopen routes, revoke members, or grant allowance.
- A complete human-configured communication graph for every round.
- Automatic retries or refunds after uncertain delivery.
- A continuously running cleanup daemon or any model invocation for maintenance.
- Rewriting or discarding valid existing ledger history during migration.

## Chosen Architecture

Use a validated ledger v3 with:

- stable logical members whose IDs survive rename, suspension, resume, and human-confirmed session takeover;
- transient private leases that fence old processes;
- bounded member, transport, conversation, and history lifetimes;
- pairwise directional routes with `open`, `closed`, and `reply-only` states;
- explicit `notice`, `request`, and `reply` message kinds;
- weighted allowance reservations that reserve request and reply capacity atomically;
- opportunistic, model-free maintenance;
- a one-time static tool-schema update with no in-session schema or prompt mutation.

This is preferred over patching the current peer model because identity, session attachment, conversation state, and routing need separate invariants. Existing state is migrated rather than reset.

## Trust and Control Boundary

Messaging remains same-machine and same-user. The authenticated loopback NATS authority and its CAS-controlled ledger are authoritative.

Humans exclusively control:

- group creation and selection;
- joining and leaving;
- new member creation;
- session takeover;
- route reopening or manual closure;
- allowance arming and pausing;
- revocation, recovery, and package rollout.

Agents may only:

- discover current public member and route metadata;
- rename their own attached member;
- inspect their own outgoing metadata;
- send a protocol-valid message over an available route.

No public DTO or output may contain broker credentials, private leases, full settings, or message bodies obtained from storage.

## Stable Membership

### Member record

A member is a stable channel identity, conceptually:

```text
Member
- id                  stable routing ID
- groupId
- displayName         mutable in place
- sessionId           currently attached Pi session
- lifecycle           active | suspended | left
- lastSeen
- suspendedAt?
- endedAt?
- endReason?          leave | revoke | expired
- private leaseId     never public
```

A stale member is an `active` member whose heartbeat is older than the 30-second online window. Staleness is derived presence, not a separate lifecycle state.

Renaming changes only `displayName`. It does not create a member, change its ID, reset routes, alter allowance, or reroute queued work.

### Suspension and expiry

- Normal reload, shutdown, session replacement, and tree navigation suspend the member.
- Suspension records `suspendedAt` and rotates the private lease.
- A suspended member remains resumable for 24 hours.
- A crashed active member expires 24 hours after `lastSeen` if it never suspended cleanly.
- Expiry occurs when `now >= expiry timestamp`.
- Explicit leave or revoke finalizes the member immediately.
- Finalization rotates the lease, closes and removes its routes, and releases its active-member slot.

Normal human status and agent discovery show current active or suspended members only. Left/expired tombstones are not presented as channel members. Retained message metadata continues to carry immutable sender attribution for audit purposes.

### Human-confirmed takeover

A new saved Pi session may take over a stale or suspended member after explicit human selection and confirmation.

Takeover atomically:

1. preserves the member ID, display name, inbox, route state, and retained history;
2. replaces the attached `sessionId`;
3. rotates the private lease;
4. clears suspension and refreshes the heartbeat;
5. fences all mutations from the old process;
6. grants no allowance.

An online member cannot be taken over. The human must return to that session or revoke it and create a new member. Display-name matching never triggers automatic reuse.

### Finalization effects

When a member leaves, is revoked, or expires:

- queued messages to or from it expire immediately and release only unspent reservations;
- attempted messages to or from it become terminal-unresolved immediately, with no refund or replay;
- open requests involving it become unanswered and release only unused reply reservations;
- pair routes involving it are removed;
- its durable consumer becomes eligible for deletion;
- its tombstone remains until no retained message references it.

Physical member deletion occurs only after all retained references are pruned.

## Pairwise Route State Machine

Each unordered active-member pair has two directional route records. When a new member joins, both directions between it and every existing current member start `open`.

A direction is one of:

```text
open
closed
reply-only(requestMessageId, observedAt?, expiresAt?)
```

Agents cannot mutate route state directly. Human `/messages routes` controls may explicitly open or close a direction.

### Notice from A to B

A notice is a terminal communication that forbids a response.

Preconditions:

- `A -> B` is `open`;
- no queued or attempted traffic exists from B to A;
- no reply or request conversation is open for the pair.

The send CAS atomically queues the notice and closes `B -> A`. `A -> B` remains open.

The reverse-traffic check makes the guarantee deterministic under concurrency. If a B-to-A send commits first, A's notice is rejected. If A's notice commits first, every later B-to-A initiation is rejected. A fresh notice cannot be used to bypass the closure.

### Request from A to B

A request permits exactly one direct reply.

Preconditions:

- `A -> B` is `open`;
- no queued or attempted reverse traffic exists;
- no conversation is already open for the pair;
- two allowance slots are available.

The send CAS atomically:

1. queues the request;
2. reserves one delivery slot and one reply slot;
3. changes `B -> A` to `reply-only(requestId)`.

The reply capability is not usable until exact delivery observation commits. Observation starts a one-hour reply window.

While the request is open, A cannot replace it with another conversation to B.

### Reply from B to A

A reply must:

- name an exact `inReplyTo` request ID;
- be sent by that request's exact recipient;
- target that request's exact sender;
- reference a request whose delivery was observed;
- arrive before the one-hour deadline;
- use the reply slot reserved by the request.

Queuing a reply atomically consumes the capability. Duplicate, nested, third-party, misrouted, unobserved, and late replies fail closed.

A reply cannot itself receive an acknowledgement. Accepting it closes `A -> B`, while consuming and closing `B -> A`. The exchange ends with both directions closed. A later independent exchange requires a human to reopen a direction.

### Limits of the guarantee

The system does not classify prose. Instead, it prevents a disguised response by denying all B-to-A traffic after an A-to-B notice. A human can intentionally authorize later independent B-to-A communication by reopening that direction.

Agents cannot evade the lock by renaming or reconnecting because route state is attached to the stable member ID. Creating a distinct member remains an explicit human action.

## Message Model

New sends use exactly one kind:

- `notice`: no `inReplyTo`; closes the reverse route;
- `request`: no `inReplyTo`; creates one reply capability;
- `reply`: requires `inReplyTo`; consumes that exact capability.

There is no default kind. Missing or contradictory fields are rejected.

Transport state remains distinct from conversation outcome. Transport states include:

- `queued`;
- `attempted`;
- `observed`;
- `canceled`;
- `dismissed`;
- `expired` for work never admitted;
- `terminal-unresolved` for admitted work without confirmation.

A request additionally records a conversation outcome such as:

- `pending-delivery`;
- `awaiting-reply`;
- `reply-pending`;
- `answered`;
- `unanswered`.

Terminal timestamps are explicit and provide the basis for retention.

## Deadlines and Retention

### Queued delivery

Any queued notice, request, or reply expires one hour after creation if it has not been admitted.

- No admission was spent, so its reservation is released rather than refunded.
- A queued request releases both its delivery and reply reservations.
- Route state closes conservatively; expiry never reopens a route.

### Attempted delivery

An attempted message that lacks exact observation for ten minutes becomes `terminal-unresolved`.

- Its admission remains spent.
- It is never replayed or automatically retried.
- An attempted request releases its unused reply reservation when terminalized.
- Route state remains closed.

### Delivered request

A request's one-hour reply window begins only when exact delivery observation commits.

If no reply is queued before the deadline:

- the request becomes `unanswered`;
- its unused reply reservation is released;
- the reply-only route closes;
- no route is reopened.

If a reply is queued in time, that reply receives its own one-hour queued-delivery window. If it fails or becomes uncertain, the exchange stays closed and requires human recovery.

### History retention

Terminal message metadata and bodies are retained for seven days after their final terminal or conversation-outcome timestamp. They then become eligible for automatic pruning regardless of whether the sender remains active.

Request-key deduplication is guaranteed only for the retained seven-day history window. A terminal record is never pruned while another retained record or active reply capability depends on it.

## Allowance Accounting

The group maintains this invariant:

```text
used admissions
+ queued delivery reservations
+ open reply reservations
<= current round limit
```

Weights are:

- notice: one delivery reservation;
- request: one delivery reservation plus one reply reservation;
- reply: uses the reply reservation already owned by its request.

Admission, not queueing, increments `used`. Once spent, admission is never refunded.

Arming a new round replaces unused allowance as before, but the requested limit must cover all queued deliveries and open reply reservations. Arming, pausing, resume, takeover, rename, expiry, and maintenance never create hidden capacity.

Batch admission still spends one credit per delivered message and preserves publication order. Weighted reservations affect admission headroom, not the order or per-message cost of actual delivery.

## Maintenance

Maintenance is opportunistic and model-free. It runs from:

- joined-session heartbeats;
- participant mutations such as send and reserve;
- explicit human messaging commands.

NATS/broker startup does not join, migrate participation, expire state, deliver, arm, read bodies, or invoke a model. With no extension connected, wall-clock deadlines are enforced on the next maintenance opportunity; expired work is never admitted after its deadline.

Cleanup order is conservative:

1. validate time and ledger invariants;
2. CAS-commit message expiry, request timeout, member finalization, and route closure;
3. enumerate transport resources from committed metadata;
4. idempotently purge eligible bodies and inactive consumers;
5. CAS-delete metadata only if it remains eligible and older than seven days.

Transport cleanup failure may leave inaccessible residue but cannot reactivate a member, reopen a route, refund allowance, or redeliver terminal work. Later maintenance retries residue cleanup.

## Public Agent API

`peer_message` remains one statically registered tool with actions:

```text
peers | status | send | rename
```

Send inputs add a required static field:

```text
kind: notice | request | reply
toPeerId: stable member ID
text: nonempty bounded body
inReplyTo: required only for reply
```

The schema, description, snippet, and prompt guidelines are registered once and never mutated during a process.

### Peer discovery

`peers` returns public member identity, presence, and the caller's send mode toward each peer:

```text
open | closed | reply-only
```

For `reply-only`, it may return the permitted request ID and deadline. It never returns leases, tokens, stored bodies, or private configuration.

### Status

Agent status remains metadata-only, outbound-only, and paginated. It distinguishes queued, attempted, awaiting-reply, unanswered, and terminal-unresolved conditions rather than reporting a single ambiguous pending count.

Agents are instructed not to poll or wait for replies. A send result is a queue receipt, never proof of delivery or task completion.

### Rename

Rename remains self-only, TUI-only, and in-place. It cannot target another member or affect route state.

## Human UI

The `/messages` command retains join, leave, arm, pause, send, inbox, prune, revoke, and status controls, and adds `routes`.

- `join` may create a new member or offer human-confirmed takeover of stale/suspended members.
- `status` shows only current channel members and separates delivery, conversation, and unresolved counts.
- `routes` displays both directions for a pair and lets the human explicitly open or close one. Opening a route grants no allowance. Replacing an active `reply-only` route requires a separate confirmed recovery action that first marks the request unanswered and releases only its unused reply reservation; ordinary route editing cannot silently discard a conversation.
- `send` requires a notice/request choice.
- Inbox reply composition is available only for a delivered request with the exact current capability.
- Recovery warnings state that route changes and terminalization do not recall admitted Pi messages or refund credits.

Every human dialog remains guarded against session/tree replacement before and after asynchronous UI boundaries.

## Delivery and Runtime

Delivery remains idle-boundary-only and batch-shaped. Busy work cannot enable admission or receive steering messages.

Each batch uses one stable wrapper and stable field order. Each message includes:

- kind;
- message ID;
- stable sender attribution;
- exact reply directive;
- deadline where applicable;
- escaped JSON-string body.

Notice delivery states that replies are forbidden and the reverse route is closed. Request delivery identifies the one permitted request ID. Reply delivery states that no acknowledgement is allowed.

Exact batch receipt correlation remains required before `attempted` becomes `observed`. For a request, that same observation atomically starts the reply deadline.

## Prompt-Cache Stability

The implementation must not reintroduce avoidable provider prompt-cache invalidation.

- The tool set does not change after extension registration.
- `peer_message` uses one static schema for the process lifetime.
- Tool descriptions, snippets, and prompt guidelines contain no dynamic member, group, route, clock, allowance, or identity values.
- Route enforcement occurs in the backend rather than through dynamic tool enablement.
- Dynamic state appears only in explicit tool results, TUI status, or newly appended genuine delivery messages.
- Heartbeat and maintenance operations append no conversation messages.
- There is no polling or periodic synthetic prompt traffic.
- Delivery wrapper shape and field ordering are stationary.
- Package application and the one-time schema transition occur only at an explicit human-controlled idle boundary.

## Migration to Ledger v3

The backend accepts exact valid v1, v2, or v3 state. A v1 or v2 ledger migrates losslessly to v3 using one expected-revision CAS before backend exposure.

Migration preserves:

- authority and group IDs;
- member/peer IDs;
- names and session attribution;
- active/suspended lifecycle meaning;
- message IDs and sequence numbers;
- request keys and payload hashes;
- transport state, attempt IDs, rounds, timestamps, and counters;
- current allowance use and mode.

Existing peers become stable members. Existing active-member pairs start open in both directions.

Existing messages become migration-only `legacy` records. Legacy records preserve accounting and transport behavior but create no new reply capability. New public sends cannot create `legacy` messages. Pending legacy records use the one-hour queued and ten-minute attempted deadlines, while terminal legacy records use seven-day retention.

Suspended members without an explicit v3 suspension timestamp derive it conservatively from their existing lifecycle timestamp. Consequently, old suspended/stale members may become eligible for cleanup during the first human-triggered maintenance after migration.

Invalid input fails before mutation. A concurrent migration loser rereads the ledger and accepts only a complete, exact valid v3 winner. Any uncertain write outcome stops the backend for inspection.

The migration is forward-only: `pi-tools v0.1.1` cannot operate on v3. Rollout therefore requires a new signed immutable release and explicit human reload.

## Failure Semantics

Failures expose only bounded invariant descriptions, including:

- route closed;
- reverse traffic already pending;
- another conversation already open;
- request not observed;
- reply capability expired or consumed;
- wrong sender or recipient;
- insufficient two-credit capacity;
- member expired;
- lease fenced;
- uncertain ledger or publication outcome.

No error silently changes message kind, recipient, route, accounting, or retry behavior. Unknown outcomes are conservative: stop automated admissions, retain inspectable metadata, do not replay, and do not refund spent credits.

## Verification Strategy

### Pure policy tests

Use explicit clocks and cover:

- repeated rename without member growth;
- exact 24-hour member expiry boundaries;
- takeover and old-lease fencing;
- immediate departure finalization;
- tombstone dependency retention;
- initial bidirectional routes;
- notice reverse closure;
- reverse-pending rejection and concurrent CAS ordering;
- two-slot request reservation;
- exact single reply authorization;
- rejection of duplicate, nested, late, misrouted, and third-party replies;
- route closure after reply;
- exact one-hour, ten-minute, one-hour-reply, and seven-day boundaries;
- no attempted-credit refunds;
- weighted re-arm validation;
- dependency-safe pruning.

### Isolated real-broker tests

Use disposable authenticated NATS servers and temporary homes to cover:

- literal v1/v2 migration and concurrent migration fencing;
- durable inbox preservation across takeover;
- inactive-consumer deletion;
- ledger-first body cleanup and cleanup retry;
- absence of redelivery after expiry;
- exact reply routing and one-time consumption;
- weighted batch allowance invariants;
- hard restart behavior.

Tests never connect to or mutate the live broker, ledger, identities, groups, allowances, messages, or configuration.

### Extension and runtime tests

Cover:

- no list growth after rename, leave, expiry, or takeover;
- human-only route and lifecycle controls;
- metadata-only discovery and status;
- stable idle-boundary batching and receipt correlation;
- no body reads outside explicit human inbox actions;
- lifecycle/maintenance silence in conversation history;
- session/tree race guards;
- escaping of terminal controls and message delimiters.

### Cache-stability regression tests

Capture extension registration and assert after heartbeats, rename, discovery, status, route changes, maintenance, suspension, resume, and takeover that:

- the registered tool set is unchanged;
- the schema object and serialized schema are unchanged;
- prompt metadata is byte-stable;
- no dynamic system/context hook exists;
- maintenance never calls `sendMessage`;
- only actual admitted deliveries append custom messages;
- delivery wrapper structure and field order remain stable.

### Release gates

Before publication or rollout:

- all tests pass;
- TypeScript typecheck passes;
- production install validation loads all six entrypoints;
- repository scanning passes;
- `git diff --check` passes;
- commits and immutable tag are signed by the configured personal identity;
- trusted signature verification passes;
- CI succeeds;
- a disposable migration rehearsal succeeds;
- live apply and Pi reload occur only at a separately approved idle boundary.
