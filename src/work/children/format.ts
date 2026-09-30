import type { ChildrenConfig } from "../config.ts";
import type { ChildRun } from "../types.ts";
import { NOTE_MAX } from "../types.ts";

const money = (value: number): string => `$${value.toFixed(2)}`;
const short = (commit: string | null): string => (commit ?? "").slice(0, 12);

export function modelShortName(model: string): string {
	return (model.split("/").pop() ?? model).replace(/^claude-/, "");
}

// The last non-empty output line, with control characters turned into spaces, for acceptance and crash summaries.
export function lastLine(output: string): string {
	const lines = output
		.split(/\r?\n/)
		.map((line) => line.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim())
		.filter(Boolean);
	return (lines.at(-1) ?? "").slice(0, NOTE_MAX);
}

export function formatChildRun(run: ChildRun, note: string): string {
	const parts = [run.id, run.outcome, modelShortName(run.model), money(run.spendUsd)];
	parts.push(run.kind === "implement" ? `${run.diffLines}/${run.budgetLines} lines ${run.diffFiles}/${run.budgetFiles} files` : "read-only");
	if (run.acceptance.length > 0) parts.push(`acceptance ${run.acceptance.filter((result) => result.exitCode === 0).length}/${run.acceptance.length}`);
	if (run.flags.length > 0) parts.push(`flags ${run.flags.join(",")}`);
	parts.push(`goal: ${run.brief.goal}`);
	if (note) parts.push(`note: ${note}`);
	return parts.join("  ");
}

function nextStep(run: ChildRun): string {
	// A result can arrive after the lead has already discarded or merged the run; then nothing is left to do.
	if (run.outcome === "discarded") return "It was already discarded, so there is nothing left to do.";
	if (run.outcome === "merged") return "It was already merged, so there is nothing left to do.";
	if (run.kind === "read-only") return "Next: use the findings, or delegate follow-up work.";
	const passed = run.acceptance.length > 0 && run.acceptance.every((result) => result.exitCode === 0);
	if (run.outcome === "done" && passed) {
		return `Next: review the diff with \`git diff ${short(run.baseCommit)}...${run.branch}\`. If it is acceptable, call merge_child ${run.id}. Otherwise delegate again with from: ${run.id}, or call stop_child ${run.id} with discard: true.`;
	}
	return `Next: delegate again with from: ${run.id} to continue from its branch, or call stop_child ${run.id} with discard: true.`;
}

// The one message the lead receives when a child finishes.
export function renderResult(run: ChildRun, config: ChildrenConfig): string {
	const modified = run.flags.includes("modified-files") ? " (modified-files: it changed files in your working directory; check git status)" : "";
	const lines = [`Child ${run.id} finished: ${run.outcome}${modified}`, `Goal: ${run.brief.goal}`];
	if (run.summary) lines.push(`Summary: ${run.summary}`);
	if (run.kind === "implement") lines.push(`Diff: ${run.diffLines}/${run.budgetLines} lines, ${run.diffFiles}/${run.budgetFiles} files`);
	for (const result of run.acceptance) {
		const verdict = result.exitCode === 0 ? "pass" : "FAIL";
		const code = result.exitCode === null ? "no exit code" : `exit ${result.exitCode}`;
		lines.push(`Acceptance: ${verdict} \`${result.command}\` (${code}) ${result.summary}`.trimEnd());
	}
	lines.push(`Spend: ${money(run.spendUsd)} of ${money(config.spendCapUsd)}`);
	if (run.branch && run.outcome !== "discarded") lines.push(`Branch: ${run.branch} (base ${short(run.baseCommit)})`);
	lines.push(nextStep(run));
	return lines.join("\n");
}

export function renderInterrupted(runs: readonly ChildRun[]): string {
	return [
		"These child runs were interrupted when this session last ended:",
		...runs.map((run) => `- ${run.id} (${run.branch ?? "read-only"}): ${run.brief.goal}`),
		"For each, delegate again (implement runs can continue with from: C-<n>) or call stop_child with discard: true.",
	].join("\n");
}
