import type { ChildrenConfig } from "../config.ts";
import { repoChildrenConfig } from "../config.ts";
import type { Brief, ChildKind } from "../types.ts";
import { expensiveVerdict, restrictedVerdict } from "./guards.ts";

export const GOAL_MAX = 200;
export const CONTEXT_MAX = 4000;

export type BriefParams = {
	goal: string;
	kind: ChildKind;
	scope?: string[];
	non_goals?: string[];
	acceptance?: string[];
	context?: string;
	budget?: { lines?: number; files?: number };
	model?: string;
	model_reason?: string;
	from?: string;
};
export type ResolvedBrief = { brief: Brief; model: string; budgetLines: number | null; budgetFiles: number | null; notes: string[] };

const clean = (list: string[] | undefined): string[] => (list ?? []).map((entry) => entry.trim()).filter(Boolean);
const positiveInteger = (value: number): boolean => Number.isInteger(value) && value > 0;

export function resolveBrief(params: BriefParams, config: ChildrenConfig, repo: string | null): ResolvedBrief | { error: string } {
	const goal = params.goal?.trim() ?? "";
	if (!goal || goal.includes("\n") || goal.length > GOAL_MAX) return { error: `goal must be one sentence of at most ${GOAL_MAX} characters` };
	if (params.kind !== "implement" && params.kind !== "read-only") return { error: "kind must be implement or read-only" };
	const implement = params.kind === "implement";
	const scope = clean(params.scope);
	const acceptance = clean(params.acceptance);
	if (implement && scope.length === 0) return { error: "implement needs scope: the glob paths the child may change" };
	if (implement && acceptance.length === 0) return { error: "implement needs acceptance: targeted test commands that must pass" };
	const extra = repoChildrenConfig(config, repo).expensiveCommands;
	for (const command of acceptance) {
		const reason = restrictedVerdict(command) ?? expensiveVerdict(command, extra);
		if (reason) return { error: `acceptance command \`${command}\` is not allowed. ${reason}` };
	}
	const context = params.context?.trim() ?? "";
	if (context.length > CONTEXT_MAX) return { error: `context must be at most ${CONTEXT_MAX} characters` };
	const model = params.model?.trim() || null;
	const modelReason = params.model_reason?.trim() || null;
	if (model && !modelReason) return { error: "model needs model_reason" };
	const from = params.from?.trim() || null;
	if (from && !implement) return { error: "from applies only to implement runs" };
	const notes: string[] = [];
	let budgetLines: number | null = null;
	let budgetFiles: number | null = null;
	if (implement) {
		budgetLines = params.budget?.lines ?? config.diffBudget.defaultLines;
		budgetFiles = params.budget?.files ?? config.diffBudget.defaultFiles;
		if (!positiveInteger(budgetLines) || !positiveInteger(budgetFiles)) return { error: "budget lines and files must be positive integers" };
		if (budgetLines > config.diffBudget.maxLines) {
			notes.push(`Budget capped at ${config.diffBudget.maxLines} lines.`);
			budgetLines = config.diffBudget.maxLines;
		}
	}
	return {
		brief: { goal, kind: params.kind, scope, nonGoals: clean(params.non_goals), acceptance, context, model, modelReason, from },
		model: model ?? config.defaultModel,
		budgetLines,
		budgetFiles,
		notes,
	};
}

// Appended to the child's system prompt once, at start, so it stays the same for the whole session.
export function renderChildPrompt(run: { id: string; brief: Brief; budgetLines: number | null; budgetFiles: number | null; branch: string | null }, config: ChildrenConfig): string {
	const b = run.brief;
	const lines = [
		`# Child run ${run.id}`,
		"",
		"You are a child agent working for a project lead. You cannot talk to the user; the lead reads your final session_status note.",
		"",
		"## Brief",
		`Goal: ${b.goal}`,
		`Kind: ${b.kind}`,
	];
	if (b.scope.length > 0) lines.push(`Scope (the only paths you may change): ${b.scope.join(", ")}`);
	if (b.nonGoals.length > 0) lines.push(`Non-goals: ${b.nonGoals.join("; ")}`);
	if (b.acceptance.length > 0) lines.push("Acceptance (must pass):", ...b.acceptance.map((command) => `- \`${command}\``));
	if (b.context) lines.push("", "## Context", b.context);
	lines.push("", "## Rules", "- Less is more: make the smallest change that meets the goal. No unrequested refactors, scaffolding, or extra tests.");
	if (b.kind === "implement") {
		lines.push(
			`- Diff budget: ${run.budgetLines} lines and ${run.budgetFiles} files against your starting commit. Edits stop at the budget.`,
			"- Run only the tests covering the files you change. Repository-wide test runs are blocked; CI runs the full suite on the draft PR.",
			`- Commit your work on your branch (${run.branch}) with git add and git commit. Never push, open PRs, rebase, amend, or switch branches.`,
			"- Needing a dependency, or a path outside your scope, is a question for the lead: stop and say so.",
		);
	} else {
		lines.push("- This run is read-only: edit and write are disabled. Do not change files with shell commands either.");
	}
	lines.push(
		`- Spending cap: $${config.spendCapUsd.toFixed(2)}. Shell commands time out after ${config.commandTimeoutMinutes} minutes.`,
		`- End with session_status: \`done\` with a one-line summary when the goal is met${b.kind === "implement" ? " and committed" : ""}, or \`needs-me\` with the question that blocks you.`,
	);
	return lines.join("\n");
}

export function renderFirstPrompt(brief: Brief): string {
	return `Start on your brief (in the system prompt): ${brief.goal}`;
}
