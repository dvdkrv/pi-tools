import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import {
	discoverRepositories,
	ensureWorktree,
	errorText,
	parseWorktreeManagerConfig,
	slugify,
	tmuxPiLaunchCommand,
	type RepoCandidate,
} from "../src/worktree/index.ts";

export type TaskConfig = { model?: string; warnings: string[] };
export type InferredTask = {
	repoAlias: string;
	goal: string;
	worktreeName: string;
	kickoffPrompt: string;
	baseRef?: string;
};
export type TaskArgs = { request: string; split: boolean };

type MinimalTaskContext = {
	cwd: string;
	mode: "tui" | "rpc" | "json" | "print";
	model?: any;
	modelRegistry: {
		find?: (provider: string, model: string) => any;
		getApiKeyAndHeaders: (model: any) => Promise<{ ok: true; apiKey?: string; headers?: Record<string, string> } | { ok: false; error: string }>;
	};
	ui: {
		notify: (message: string, level?: "info" | "warning" | "error") => void;
		confirm?: (title: string, message: string) => Promise<boolean>;
		custom: <T>(factory: (tui: { requestRender: () => void }, theme: any, keybindings: unknown, done: (value: T) => void) => any) => Promise<T>;
		input: (title: string, placeholder?: string) => Promise<string | undefined>;
	};
};

export function parseTaskConfig(raw: string): TaskConfig {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { warnings: ["task config is not valid JSON"] };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { warnings: ["task config must be an object"] };
	}

	const warnings: string[] = [];
	const config: TaskConfig = { warnings };
	const input = parsed as { model?: unknown };
	if (input.model !== undefined) {
		if (typeof input.model !== "string" || !input.model.includes("/")) {
			warnings.push("model must be a provider/model string");
		} else {
			config.model = input.model;
		}
	}
	return config;
}

function taskConfigPath(): string {
	return join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "task.json");
}

function worktreeConfigPath(): string {
	return join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "worktree-manager.json");
}

export function parseTaskArgs(args: string): TaskArgs {
	const pieces = args.trim().split(/\s+/).filter(Boolean);
	const split = pieces.includes("--split");
	return {
		split,
		request: pieces.filter((piece) => piece !== "--split").join(" "),
	};
}

function loadTaskConfig(): TaskConfig {
	const path = taskConfigPath();
	if (!existsSync(path)) return { warnings: [] };
	return parseTaskConfig(readFileSync(path, "utf8"));
}

function loadWorktreeConfig(): { repoSearchRoots: string[]; warnings: string[] } {
	const path = worktreeConfigPath();
	if (!existsSync(path)) return { repoSearchRoots: [], warnings: [] };
	return parseWorktreeManagerConfig(readFileSync(path, "utf8"));
}

export function buildTaskInferencePrompt(request: string, repos: RepoCandidate[]): string {
	const repoList = repos.map((repo) => `- ${repo.alias}: ${repo.root}`).join("\n") || "- none";
	return `You turn a user's task request into a concise Pi task handoff.\n\nUser request:\n${request}\n\nCandidate repositories:\n${repoList}\n\nChoose exactly one repoAlias from the candidate repositories. Choose a short kebab-case-ish worktreeName that describes the task. Write a kickoffPrompt for a fresh Pi session with the goal, useful context, and constraints. Omit baseRef unless the user explicitly asks to base the task on a specific branch, tag, commit, or the current branch.\n\nReturn only JSON with this shape:\n{"repoAlias":"repo-alias","goal":"one sentence goal","worktreeName":"short task name","kickoffPrompt":"detailed kickoff prompt","baseRef":"optional explicit branch/tag/commit"}`;
}

function stripJsonFence(text: string): string {
	const trimmed = text.trim();
	const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	return (fenced?.[1] ?? trimmed).trim();
}

export function parseTaskInference(text: string): InferredTask {
	const parsed = JSON.parse(stripJsonFence(text)) as Partial<InferredTask>;
	for (const key of ["repoAlias", "goal", "worktreeName", "kickoffPrompt"] as const) {
		if (typeof parsed[key] !== "string" || !parsed[key]?.trim()) {
			throw new Error(`Task inference missing ${key}`);
		}
	}
	const { repoAlias, goal, worktreeName, kickoffPrompt } = parsed;
	if (!repoAlias || !goal || !worktreeName || !kickoffPrompt) {
		throw new Error("Task inference did not contain complete string fields");
	}
	return {
		repoAlias: repoAlias.trim(),
		goal: goal.trim(),
		worktreeName: slugify(worktreeName.trim()),
		kickoffPrompt: kickoffPrompt.trim(),
		...(typeof parsed.baseRef === "string" && parsed.baseRef.trim() ? { baseRef: parsed.baseRef.trim() } : {}),
	};
}

export function buildKickoffPrompt(input: {
	originalRequest: string;
	repo: RepoCandidate;
	goal: string;
	kickoffPrompt: string;
	baseRef?: string;
}): string {
	const baseLine = input.baseRef ? `\nBase ref: ${input.baseRef}` : "";
	return `Goal: ${input.goal}\n\nRepository: ${input.repo.alias}\nPath: ${input.repo.root}\nOriginal request: ${input.originalRequest}${baseLine}\n\nContext and constraints:\n${input.kickoffPrompt}\n\nUse the relevant Pi skills before coding. Start by inspecting the repository context, clarify only if the goal is ambiguous, and verify changes with the appropriate tests before reporting completion.`;
}

export function buildTaskLaunchCommand(
	worktree: { name: string; path: string },
	prompt: string,
	options: { split: boolean; insideTmux: boolean },
): ReturnType<typeof tmuxPiLaunchCommand> {
	return tmuxPiLaunchCommand({
		name: worktree.name,
		path: worktree.path,
		prompt,
		insideTmux: options.insideTmux,
		split: options.split,
		autoCleanup: true,
	});
}

export function reviewInputAction(data: string): { type: "launch" | "edit" | "cancel" } | undefined {
	if (matchesKey(data, Key.enter)) return { type: "launch" };
	if (data === "E") return { type: "edit" };
	if (matchesKey(data, Key.escape)) return { type: "cancel" };
	return undefined;
}

function extractText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => Boolean(part) && typeof part === "object" && (part as any).type === "text" && typeof (part as any).text === "string")
		.map((part) => part.text)
		.join("\n");
}

function resolveConfiguredModel(configModel: string | undefined, ctx: MinimalTaskContext): any | undefined {
	if (!configModel) return ctx.model;
	const slash = configModel.indexOf("/");
	const provider = configModel.slice(0, slash);
	const id = configModel.slice(slash + 1);
	return ctx.modelRegistry.find?.(provider, id);
}

async function inferTask(request: string, repos: RepoCandidate[], config: TaskConfig, ctx: MinimalTaskContext): Promise<InferredTask> {
	const model = resolveConfiguredModel(config.model, ctx);
	if (!model) throw new Error(config.model ? `Configured model not found: ${config.model}` : "No active model");
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(auth.error);
	if (!auth.apiKey) throw new Error("No API key available for task model");

	const response = await complete(
		model,
		{
			messages: [
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: buildTaskInferencePrompt(request, repos) }],
					timestamp: Date.now(),
				},
			],
		},
		{ apiKey: auth.apiKey, headers: auth.headers, reasoningEffort: "low" },
	);
	return parseTaskInference(extractText(response.content));
}

async function reviewTask(ctx: MinimalTaskContext, task: InferredTask, repo: RepoCandidate, kickoffPrompt: string): Promise<"launch" | "edit" | "cancel"> {
	return ctx.ui.custom((tui, theme, _keybindings, done) => ({
		invalidate(): void {},
		render(width: number): string[] {
			const lines: string[] = [];
			lines.push(new DynamicBorder((s: string) => theme.fg("accent", s)).render(width)[0] ?? "");
			lines.push(truncateToWidth(theme.fg("accent", theme.bold("Start task?")), width));
			lines.push(truncateToWidth(`Repo: ${repo.alias} — ${repo.root}`, width));
			lines.push(truncateToWidth(`Worktree: ${task.worktreeName}`, width));
			lines.push(truncateToWidth(`Base: ${task.baseRef ?? "latest default branch"}`, width));
			lines.push(truncateToWidth(`Goal: ${task.goal}`, width));
			lines.push("");
			for (const line of kickoffPrompt.split("\n").slice(0, 12)) lines.push(truncateToWidth(line, width));
			lines.push("");
			lines.push(truncateToWidth(theme.fg("dim", "Enter launch • E edit name/prompt • Esc cancel"), width));
			lines.push(new DynamicBorder((s: string) => theme.fg("accent", s)).render(width)[0] ?? "");
			return lines;
		},
		handleInput(data: string): void {
			const action = reviewInputAction(data);
			if (!action) return;
			done(action.type);
		},
	}));
}

async function maybeEditTask(ctx: MinimalTaskContext, task: InferredTask, kickoffPrompt: string): Promise<{ task: InferredTask; kickoffPrompt: string } | undefined> {
	const name = (await ctx.ui.input("Worktree name", task.worktreeName))?.trim();
	if (!name) return undefined;
	const prompt = (await ctx.ui.input("Kickoff prompt", kickoffPrompt))?.trim();
	if (!prompt) return undefined;
	return { task: { ...task, worktreeName: slugify(name) }, kickoffPrompt: prompt };
}

async function discoverTaskRepositories(ctx: MinimalTaskContext): Promise<{ config: TaskConfig; repos: RepoCandidate[] }> {
	const taskConfig = loadTaskConfig();
	for (const warning of taskConfig.warnings) ctx.ui.notify(warning, "warning");
	const worktreeConfig = loadWorktreeConfig();
	for (const warning of worktreeConfig.warnings) ctx.ui.notify(warning, "warning");
	const discovered = discoverRepositories({ cwd: ctx.cwd, config: worktreeConfig });
	for (const warning of discovered.warnings) ctx.ui.notify(warning, "warning");
	return { config: taskConfig, repos: discovered.repos };
}

async function runTaskCommand(args: string, ctx: MinimalTaskContext): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/task is available only in interactive TUI mode", "error");
		return;
	}

	const parsedArgs = parseTaskArgs(args);
	const request = parsedArgs.request;
	if (!request) {
		ctx.ui.notify("Usage: /task <task description>", "warning");
		return;
	}

	const discovered = await discoverTaskRepositories(ctx);
	if (discovered.repos.length === 0) {
		ctx.ui.notify("No repos found. Configure ~/.pi/agent/worktree-manager.json or run /task from a git repo.", "error");
		return;
	}

	let inferred: InferredTask;
	try {
		ctx.ui.notify("Inferring task handoff...", "info");
		inferred = await inferTask(request, discovered.repos, discovered.config, ctx);
	} catch (error) {
		ctx.ui.notify(`Task inference failed: ${errorText(error)}`, "error");
		return;
	}

	const repo = discovered.repos.find((candidate) => candidate.alias === inferred.repoAlias);
	if (!repo) {
		ctx.ui.notify(`Inferred repo not found: ${inferred.repoAlias}`, "error");
		return;
	}

	let kickoffPrompt = buildKickoffPrompt({ originalRequest: request, repo, goal: inferred.goal, kickoffPrompt: inferred.kickoffPrompt, baseRef: inferred.baseRef });
	while (true) {
		const action = await reviewTask(ctx, inferred, repo, kickoffPrompt);
		if (action === "cancel") return;
		if (action === "edit") {
			const edited = await maybeEditTask(ctx, inferred, kickoffPrompt);
			if (!edited) return;
			inferred = edited.task;
			kickoffPrompt = edited.kickoffPrompt;
			continue;
		}
		break;
	}

	try {
		const worktree = ensureWorktree(repo.root, inferred.worktreeName, { baseRef: inferred.baseRef, defaultBase: "remoteDefault" });
		const launch = buildTaskLaunchCommand(worktree, kickoffPrompt, { split: parsedArgs.split, insideTmux: Boolean(process.env.TMUX) });
		execFileSync(launch.command, launch.args, { encoding: "utf8" });
		ctx.ui.notify(`${worktree.created ? "Created" : "Using"} ${repo.alias} / ${worktree.name}. ${launch.description}`, "info");
	} catch (error) {
		ctx.ui.notify(`Task launch failed: ${errorText(error)}`, "error");
	}
}

export default function taskExtension(pi: ExtensionAPI): void {
	pi.registerCommand("task", {
		description: "Infer a task, create a Pi worktree, and launch a fresh Pi tmux session",
		handler: async (args, ctx) => {
			await runTaskCommand(args || "", ctx as MinimalTaskContext);
		},
	});
}
