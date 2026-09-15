# Pi Tools

A single [Pi](https://github.com/earendil-works/pi-mono) package containing six local-development extensions: `claude-skill`, `loop`, `messaging`, `task`, `theme-sync`, and `worktree-manager`.

## Security

Pi extensions execute with full system access. Review this repository and its pinned release before installation.

Messaging is local-first. It accepts only a token-authenticated loopback NATS endpoint and stores broker authority and JetStream data in owner-only paths. Loading the package may ensure that local infrastructure is ready, but it never joins a group, grants allowance, reads pending bodies, sends work, or invokes a model automatically.

The worktree, task, and Claude bridge commands can create processes, tmux sessions, branches, and worktrees. They are interactive commands and do not run merely because the package is loaded.

## Extensions

### claude-skill

`/claude-skill [skill-name] [arguments]` discovers Claude Code skills in project and user skill directories, presents a fuzzy picker when needed, and launches the selected skill in tmux. It requires `claude` and `tmux` in `PATH`.

### loop

`/loop start <prompt> [--max N]` starts an explicitly requested bounded prompt loop. `/loop status` reports state and `/loop stop` stops it. The model records exactly one final `loop_control` decision per iteration. The default is 12 total runs, the accepted range is 1–100, and known context use at or above 85% stops continuation. The extension provides cache-stable definitions without promising a provider cache-hit percentage.

### messaging

`/messages` provides human-controlled setup, joining, resume, status, allowance, inbox, recovery, and final leave/revoke operations. The model-facing `peer_message` tool can discover metadata, rename only itself, inspect bounded status, or queue an addressed message inside an explicitly joined group. It cannot join, arm allowance, or read pending bodies.

Each admitted message consumes one finite shared credit. Queued messages reserve capacity, recipients accept at most eight queued messages, and senders may have only one unresolved outbound. Eligible messages are delivered as one ordered batch at an idle boundary. Attempted or uncertain deliveries are never automatically replayed or refunded.

Messaging requires NATS Server 2.14.6 in `PATH` (or `NATS_SERVER`) and uses a same-user loopback trust boundary. Participation, allowance, recovery, identity resume, and active-session reload remain explicit human decisions.

### task

`/task [--split] <request>` infers a target repository and task, shows a review UI, creates or reuses a Pi-managed worktree, and launches a fresh Pi tmux session. Repository discovery is configured in `~/.pi/agent/worktree-manager.json`, for example:

```json
{
  "repoSearchRoots": ["~/src/github.com/owner"]
}
```

Automatic cleanup removes only clean Pi-managed worktrees and preserves their branches. Dirty worktrees are retained.

### theme-sync

`theme-sync` follows `light` or `dark` appearance stored in `${XDG_STATE_HOME:-~/.local/state}/theme`, falling back to `LC_TERMINAL_THEME` and then dark. It switches only Pi's built-in `light` and `dark` themes, fences watcher startup, and removes watchers on reload or shutdown.

### worktree-manager

`/worktree` opens a fuzzy picker for configured repositories and worktrees. `N` creates a Pi-managed worktree, `D` removes an eligible worktree after safety checks, Enter opens it in tmux, and Escape cancels. Managed worktrees live under `<repo>/.pi/worktrees/<name>` on `worktree-<name>` branches.

## Installation

Install the immutable signed release over SSH:

```bash
pi install git:git@github.com:dvdkrv/pi-tools.git@v0.1.1
```

Try it for one process without changing persistent package settings:

```bash
pi -e git:git@github.com:dvdkrv/pi-tools.git@v0.1.1
```

The separate Superpowers package is intentionally not bundled. Install its independently pinned release if desired.

## Messaging broker

Install NATS Server 2.14.6 using the platform package manager or upstream release. The first Pi session can ensure an authenticated detached broker on loopback. Infrastructure startup does not opt the session into messaging.

A safe first-time or upgrade flow is:

1. settle active work and close older messaging-enabled Pi processes;
2. install the package at a human-controlled idle boundary;
3. start a fresh Pi process;
4. explicitly run `/messages join <group>`;
5. confirm or select the intended saved identity;
6. inspect status and explicitly revoke unwanted historical identities.

Never copy broker credentials or data between users or machines.

## Messaging lifecycle

Reload, shutdown, session replacement, fork, and tree navigation suspend participation by default. Explicit `/messages leave` and human revoke are final. Resume rotates a private lifecycle lease that fences stale processes while retaining routing identity, role, durable inbox, queue state, and finite allowance.

The model sees identity only through the `peer_message` API. Private leases, broker tokens, queued bodies, and hidden dynamic identity context are not exposed.

## Configuration

- `~/.pi/agent/worktree-manager.json`: `repoSearchRoots` used by task and worktree-manager.
- `~/.pi/agent/task.json`: optional `model` override for `/task` inference.
- `~/.pi/agent/messaging/`: private local broker configuration and retained data.
- `${XDG_STATE_HOME:-~/.local/state}/theme`: terminal appearance state for theme-sync.

## Development

Requirements: Node.js 22.19 or newer, npm, and NATS Server 2.14.6 for mandatory messaging coverage.

```bash
npm ci --ignore-scripts
PI_MESSAGING_REQUIRE_BROKER=1 NATS_SERVER=/path/to/nats-server npm test
npm run typecheck
npm run check
```

Tests use disposable brokers and scripted providers. They must not access live messaging configuration, live groups, message bodies, allowance, sessions, or broker state. The suite performs no paid inference.

## Release policy

Releases use SSH-signed commits and signed annotated immutable tags. A broken release receives a new version; published tags are never moved or replaced.
