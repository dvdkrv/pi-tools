import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const DEFAULT_MAX_ITERATIONS = 12;
const MAX_ITERATIONS = 100;
const MAX_CONTEXT_PERCENT = 85;
const TOOL_NAME = "loop_control";
const ACTIVE_LOOP_INSTRUCTION = "An autonomous prompt loop is active. At the end of this run, call loop_control exactly once as your sole final tool call. Stop if the objective is complete; otherwise continue.";

type LoopState = {
	active: boolean;
	prompt: string;
	iteration: number;
	maxIterations: number;
	shouldContinue: boolean;
};

function isLoopState(value: unknown): value is LoopState {
	if (!value || typeof value !== "object") return false;
	const state = value as Partial<LoopState>;
	return typeof state.active === "boolean"
		&& typeof state.prompt === "string"
		&& Number.isInteger(state.iteration)
		&& typeof state.iteration === "number"
		&& state.iteration >= 0
		&& Number.isInteger(state.maxIterations)
		&& typeof state.maxIterations === "number"
		&& state.maxIterations >= 1
		&& state.maxIterations <= MAX_ITERATIONS
		&& typeof state.shouldContinue === "boolean";
}

function defaultState(): LoopState {
	return { active: false, prompt: "", iteration: 0, maxIterations: DEFAULT_MAX_ITERATIONS, shouldContinue: false };
}

export default function loopExtension(pi: ExtensionAPI): void {
	let state = defaultState();
	let decisionRecorded = false;
	let peakContextPercent: number | undefined;

	function toolIsAvailable(): boolean {
		return pi.getActiveTools().includes(TOOL_NAME);
	}

	function persist(extra: Record<string, unknown> = {}): void {
		pi.appendEntry("loop-state", { ...state, ...extra });
	}

	function stopLoop(reason: string, persistTransition = true): void {
		const wasActive = state.active;
		state = { ...state, active: false, shouldContinue: false };
		decisionRecorded = true;
		if (persistTransition && wasActive) persist({ reason, stoppedAt: Date.now() });
	}

	function startLoop(prompt: string, max: number): void {
		state = {
			active: true,
			prompt,
			iteration: 0,
			maxIterations: max,
			shouldContinue: false,
		};
		decisionRecorded = false;
		peakContextPercent = undefined;
		persist({ startedAt: Date.now() });
	}

	pi.registerTool({
		name: TOOL_NAME,
		label: "Loop Control",
		description: "Record the one final stop/continue decision for a prompt loop. Call only when the current system prompt says an autonomous loop is active.",
		parameters: Type.Object({
			action: StringEnum(["stop", "continue"] as const),
			reason: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params) {
			if (!state.active || decisionRecorded) {
				return {
					content: [{ type: "text", text: state.active ? "Loop decision already recorded." : "Loop is already inactive." }],
					details: state,
					terminate: true,
				};
			}

			// Set before persistence so parallel tool calls cannot record two decisions.
			decisionRecorded = true;
			if (params.action === "stop") {
				stopLoop(params.reason || "Stopped by agent");
				return {
					content: [{ type: "text", text: `Loop stopped. ${params.reason || ""}`.trim() }],
					details: state,
					terminate: true,
				};
			}

			state = { ...state, shouldContinue: true };
			persist({ reason: params.reason || "Continuation requested" });
			return {
				content: [{ type: "text", text: "Loop will continue after this run settles." }],
				details: state,
				terminate: true,
			};
		},
	});

	pi.registerCommand("loop", {
		description: "Start/stop/show autonomous prompt loop: /loop start <prompt> [--max N], /loop stop, /loop status",
		handler: async (args, ctx) => {
			const raw = (args || "").trim();
			if (!raw || raw === "status") {
				ctx.ui.notify(
					state.active
						? `Loop active: iteration ${state.iteration}/${state.maxIterations} | prompt: ${state.prompt}`
						: "Loop is inactive",
					"info",
				);
				return;
			}

			if (raw === "stop") {
				stopLoop("Stopped by user");
				ctx.ui.notify("Loop stopped", "info");
				ctx.ui.setStatus("loop", undefined);
				return;
			}

			const match = raw.match(/^start\s+(.+)$/);
			if (!match) {
				ctx.ui.notify("Usage: /loop start <prompt> [--max N] | /loop stop | /loop status", "warning");
				return;
			}

			let body = match[1].trim();
			let max = DEFAULT_MAX_ITERATIONS;
			if (/(?:^|\s)--max(?:\s|$)/.test(body)) {
				const maxMatch = body.match(/^(.*?)\s*--max\s+(\d+)$/);
				if (!maxMatch) {
					ctx.ui.notify("Loop maximum must be a final integer from 1 to 100", "warning");
					return;
				}
				body = maxMatch[1].trim();
				max = Number(maxMatch[2]);
				if (!Number.isSafeInteger(max) || max < 1 || max > MAX_ITERATIONS) {
					ctx.ui.notify("Loop maximum must be an integer from 1 to 100", "warning");
					return;
				}
			}
			if (!body) {
				ctx.ui.notify("Prompt cannot be empty", "warning");
				return;
			}

			if (!toolIsAvailable()) {
				ctx.ui.notify("Cannot start loop: loop_control is unavailable", "warning");
				return;
			}

			startLoop(body, max);
			ctx.ui.setStatus("loop", `loop ${state.iteration}/${state.maxIterations}`);
			ctx.ui.notify(`Loop started (max ${state.maxIterations})`, "info");
			try {
				pi.sendUserMessage(body);
			} catch (error) {
				stopLoop("Failed to queue initial loop prompt");
				ctx.ui.setStatus("loop", undefined);
				ctx.ui.notify(`Loop stopped: could not queue initial prompt (${error instanceof Error ? error.message : String(error)})`, "warning");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		state = defaultState();
		decisionRecorded = false;
		peakContextPercent = undefined;
		const entries = ctx.sessionManager.getBranch();
		for (let index = entries.length - 1; index >= 0; index -= 1) {
			const entry = entries[index];
			if (entry.type !== "custom" || entry.customType !== "loop-state" || !isLoopState(entry.data)) continue;
			state = entry.data;
			break;
		}
		decisionRecorded = state.shouldContinue;
		if (state.active && state.shouldContinue) {
			stopLoop("Interrupted after a continuation decision; restart explicitly");
		} else if (state.active && !toolIsAvailable()) {
			stopLoop("loop_control unavailable while restoring loop");
			ctx.ui.notify("Loop stopped: loop_control is unavailable", "warning");
		}
		ctx.ui.setStatus("loop", state.active ? `loop ${state.iteration}/${state.maxIterations}` : undefined);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!state.active) return;
		if (!toolIsAvailable()) {
			stopLoop("loop_control unavailable before loop request");
			ctx.ui.setStatus("loop", undefined);
			ctx.ui.notify("Loop stopped: loop_control is unavailable", "warning");
			return;
		}
		return { systemPrompt: event.systemPrompt + "\n\n" + ACTIVE_LOOP_INSTRUCTION };
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== TOOL_NAME) return;
		ctx.ui.setStatus("loop", state.active ? `loop ${state.iteration}/${state.maxIterations}` : undefined);
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!state.active) return;
		const percent = ctx.getContextUsage()?.percent;
		if (percent !== null && percent !== undefined) peakContextPercent = Math.max(peakContextPercent ?? 0, percent);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (!state.active) return;
		if (!decisionRecorded || !state.shouldContinue) {
			stopLoop("Agent did not request continue");
			ctx.ui.notify("Loop stopped: agent chose not to continue", "info");
			ctx.ui.setStatus("loop", undefined);
			return;
		}

		if (!toolIsAvailable()) {
			stopLoop("loop_control unavailable before loop continuation");
			ctx.ui.notify("Loop stopped: loop_control is unavailable", "warning");
			ctx.ui.setStatus("loop", undefined);
			return;
		}

		const nextIteration = state.iteration + 1;
		if (nextIteration >= state.maxIterations) {
			state = { ...state, iteration: nextIteration };
			stopLoop("Reached max iterations");
			ctx.ui.notify(`Loop stopped: reached max iterations (${state.maxIterations})`, "warning");
			ctx.ui.setStatus("loop", undefined);
			return;
		}

		const settledPercent = ctx.getContextUsage()?.percent;
		const contextPercent = settledPercent === null || settledPercent === undefined
			? peakContextPercent
			: Math.max(peakContextPercent ?? 0, settledPercent);
		if (contextPercent !== undefined && contextPercent >= MAX_CONTEXT_PERCENT) {
			state = { ...state, iteration: nextIteration };
			stopLoop(`Context usage reached ${contextPercent.toFixed(1)}%`);
			ctx.ui.notify(`Loop stopped: context usage is ${contextPercent.toFixed(1)}% (limit ${MAX_CONTEXT_PERCENT}%)`, "warning");
			ctx.ui.setStatus("loop", undefined);
			return;
		}

		state = { ...state, iteration: nextIteration, shouldContinue: false };
		decisionRecorded = false;
		peakContextPercent = undefined;
		persist({ continuedAt: Date.now() });
		ctx.ui.setStatus("loop", `loop ${state.iteration}/${state.maxIterations}`);
		try {
			pi.sendUserMessage(state.prompt, { deliverAs: "followUp" });
		} catch (error) {
			stopLoop("Failed to queue loop continuation");
			ctx.ui.setStatus("loop", undefined);
			ctx.ui.notify(`Loop stopped: could not queue continuation (${error instanceof Error ? error.message : String(error)})`, "warning");
		}
	});
}
