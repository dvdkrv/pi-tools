import { parsePrKey } from "./connectors/github.ts";
import type { GitRunner } from "./rules.ts";
import { jiraKeysIn, repoFromCwd, repoMatches } from "./rules.ts";
import type { WorkStore } from "./store.ts";
import type { Item, Link, LinkVia, Session } from "./types.ts";
import { OPEN_ITEM_STATUSES } from "./types.ts";

export const WORK_ITEM_ENV = "PI_WORK_ITEM";

export type LinkDeps = { env: NodeJS.ProcessEnv; git: GitRunner };
export type LinkMatch = { itemId: string; via: LinkVia };

function gitText(git: GitRunner, cwd: string, args: string[]): string | undefined {
	try {
		return git(cwd, args).trim() || undefined;
	} catch {
		return undefined;
	}
}

function safeItem(store: WorkStore, id: string): Item | undefined {
	try {
		return store.getItem(id);
	} catch {
		return undefined;
	}
}

function only(ids: Set<string>): string | undefined {
	return ids.size === 1 ? [...ids][0] : undefined;
}

function branchEvidence(store: WorkStore, session: Session, branch: string, git: GitRunner): Set<string> {
	const open = new Set(store.listItems({ statuses: OPEN_ITEM_STATUSES }).map((item) => item.id));
	const repo = repoFromCwd(session.cwd, git);
	const ids = new Set<string>();
	for (const link of store.listAllLinks()) {
		if (link.kind !== "github-pr" || link.state?.head !== branch || !open.has(link.itemId)) continue;
		const pr = parsePrKey(link.key);
		if (!repo || (pr && repoMatches(pr.repo, repo))) ids.add(link.itemId);
	}
	for (const key of jiraKeysIn(branch.toUpperCase())) {
		const link = store.findLinkByKey(`jira:${key}`);
		if (link && open.has(link.itemId)) ids.add(link.itemId);
	}
	return ids;
}

function worktreeEvidence(store: WorkStore, session: Session, root: string, git: GitRunner): Set<string> {
	const ids = new Set<string>();
	for (const other of store.listSessions()) {
		if (other.id === session.id) continue;
		if (other.cwd !== root && !other.cwd.startsWith(`${root}/`)) continue;
		// A path under the root can still belong to a nested worktree with its own top level.
		if (other.cwd !== session.cwd && other.cwd !== root && gitText(git, other.cwd, ["rev-parse", "--show-toplevel"]) !== root) continue;
		const link = store.sessionLink(other.id);
		if (link) ids.add(link.itemId);
	}
	return ids;
}

// First match wins: launch environment, then branch evidence, then the shared worktree. Ambiguity links nothing.
export function inferSessionLink(store: WorkStore, session: Session, deps: LinkDeps): LinkMatch | undefined {
	const fromEnv = deps.env[WORK_ITEM_ENV]?.trim();
	const envItem = fromEnv ? safeItem(store, fromEnv) : undefined;
	if (envItem) return { itemId: envItem.id, via: "env" };

	const branch = gitText(deps.git, session.cwd, ["branch", "--show-current"]);
	if (branch) {
		const ids = branchEvidence(store, session, branch, deps.git);
		if (ids.size > 1) return undefined;
		const itemId = only(ids);
		if (itemId) return { itemId, via: "branch" };
	}

	const root = gitText(deps.git, session.cwd, ["rev-parse", "--show-toplevel"]);
	if (root) {
		const itemId = only(worktreeEvidence(store, session, root, deps.git));
		if (itemId) return { itemId, via: "worktree" };
	}
	return undefined;
}

export function autoLinkSession(store: WorkStore, sessionId: string, deps: LinkDeps): Link | undefined {
	if (store.sessionLink(sessionId)) return undefined;
	const session = store.getSession(sessionId);
	if (!session) return undefined;
	const match = inferSessionLink(store, session, deps);
	return match ? store.linkSession(sessionId, match.itemId, match.via, `session:${sessionId}`) : undefined;
}
