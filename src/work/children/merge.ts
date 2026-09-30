import type { ChildrenConfig, GithubAccount } from "../config.ts";
import { repoChildrenConfig } from "../config.ts";
import type { GhRunner } from "../connectors/github.ts";
import { defaultGhRunner } from "../connectors/github.ts";
import type { GitRunner } from "../rules.ts";
import { errorMessage, redact } from "../secrets.ts";
import type { WorkStore } from "../store.ts";
import type { ChildRun } from "../types.ts";
import { defaultBranchRef, gitText, isClean, isDefaultBranch, measureDiff, parseGithubRepo, removeWorktree, runGit } from "./git.ts";
import { BUILT_IN_IGNORE } from "./guards.ts";

export type MergeDeps = { store: WorkStore; config: ChildrenConfig; accounts: readonly GithubAccount[]; git?: GitRunner; gh?: GhRunner };

type Merging = { run: ChildRun; branch: string; childBranch: string; baseCommit: string; defaultRef: string | undefined };

const FINISH = "When the whole task is complete, end with session_status needs-me and the note `ready for review: <PR URL>`.";

export async function mergeChild(deps: MergeDeps, leadSession: string, cwd: string, id: string): Promise<string> {
	const git = deps.git ?? runGit;
	let run: ChildRun | undefined;
	try {
		run = deps.store.getChildRun(id);
	} catch {
		run = undefined;
	}
	if (!run || run.leadSession !== leadSession || run.kind !== "implement" || !run.branch || !run.baseCommit) return `Refused: ${id} is not one of your implement runs.`;
	const branch = gitText(git, cwd, ["branch", "--show-current"]);
	if (!branch) return "Refused: check out your branch first (HEAD is detached).";
	const defaultRef = defaultBranchRef(git, cwd);
	if (isDefaultBranch(branch, defaultRef)) return `Refused: ${branch} is the default branch. Child work merges into a feature branch.`;
	const merging: Merging = { run, branch, childBranch: run.branch, baseCommit: run.baseCommit, defaultRef };
	// A merged run skips straight to the push and the PR, which retries a step that failed last time.
	if (run.outcome !== "merged") {
		const refusal = refusalFor(deps, git, cwd, merging);
		if (refusal) return `Refused: ${refusal}`;
		try {
			git(cwd, ["merge", "--no-ff", "-m", `Merge child ${run.id}: ${run.brief.goal}`, run.branch]);
		} catch (error) {
			try {
				git(cwd, ["merge", "--abort"]);
			} catch {
				// Nothing to abort.
			}
			return `Refused: merging ${run.branch} failed and was aborted: ${errorMessage(error)}`;
		}
		removeWorktree(git, cwd, run.worktree, run.branch);
		deps.store.markChildRunMerged(run.id, `session:${leadSession}`);
	}
	return `Merged ${run.id} into ${branch}. ${await publish(deps, git, cwd, merging)}`;
}

function refusalFor(deps: MergeDeps, git: GitRunner, cwd: string, m: Merging): string | undefined {
	const { run } = m;
	if (run.outcome !== "done") return `${run.id} is ${run.outcome}; only done runs merge.`;
	const failed = run.acceptance.filter((result) => result.exitCode !== 0);
	if (run.acceptance.length === 0 || failed.length > 0) return `acceptance did not pass (${failed.map((result) => result.command).join(", ") || "no results"}).`;
	if (!isClean(git, cwd)) return "your working tree has uncommitted changes. Commit or stash them first.";
	const ignore = [...BUILT_IN_IGNORE, ...repoChildrenConfig(deps.config, run.repo).ignore];
	const mergeBase = m.defaultRef ? gitText(git, cwd, ["merge-base", "HEAD", m.defaultRef]) : undefined;
	const lead = mergeBase ? measureDiff(git, cwd, { from: mergeBase, to: "HEAD", ignore }).lines : 0;
	const child = measureDiff(git, cwd, { from: m.baseCommit, to: m.childBranch, ignore }).lines;
	const cap = deps.config.diffBudget.prLines;
	if (lead + child > cap) return `the PR would reach ${lead + child} lines (${lead} on ${m.branch} + ${child} from ${run.id}), over the ${cap}-line cap. Split the rest into another branch and PR.`;
	return undefined;
}

// Pushes without force, then finds or creates the draft PR with the account the config maps to the repository's org.
async function publish(deps: MergeDeps, git: GitRunner, cwd: string, m: Merging): Promise<string> {
	const retry = `merge_child ${m.run.id} again to retry.`;
	try {
		const upstream = gitText(git, cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
		git(cwd, upstream ? ["push"] : ["push", "-u", "origin", m.branch]);
	} catch (error) {
		return `The push failed, and the local merge stands: ${errorMessage(error)}. Call ${retry}`;
	}
	const repo = parseGithubRepo(gitText(git, cwd, ["config", "--get", "remote.origin.url"]) ?? "");
	if (!repo) return `Pushed. origin is not a GitHub repository, so no draft PR was created. ${FINISH}`;
	const owner = (repo.split("/")[0] ?? "").toLowerCase();
	const account = deps.accounts.find((candidate) => candidate.orgs.some((org) => org.toLowerCase() === owner));
	if (!account) return `Pushed. No GitHub account in the work config covers ${owner}, so no draft PR was created. Add one, then call ${retry}`;
	const gh = deps.gh ?? defaultGhRunner;
	let token = "";
	try {
		token = (await gh(["auth", "token", "--user", account.user])).trim();
		const env = { GH_TOKEN: token };
		const open = JSON.parse((await gh(["pr", "list", "--repo", repo, "--head", m.branch, "--state", "open", "--json", "url", "--limit", "1"], env)) || "[]") as { url?: string }[];
		if (open[0]?.url) return `Pushed; the draft PR now carries the new commits: ${open[0].url}. ${FINISH}`;
		const base = m.defaultRef?.replace(/^origin\//, "") ?? "main";
		const body = `Merged child runs:\n- ${m.run.id}: ${m.run.brief.goal}${m.run.summary ? ` (${m.run.summary})` : ""}`;
		const url = (await gh(["pr", "create", "--draft", "--repo", repo, "--base", base, "--head", m.branch, "--title", m.run.brief.goal, "--body", body], env)).trim();
		return `Pushed and opened a draft PR: ${url}. ${FINISH}`;
	} catch (error) {
		return `Pushed, but the draft PR step failed: ${redact(errorMessage(error), token ? [token] : [])}. The local merge stands; call ${retry}`;
	}
}
