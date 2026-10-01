import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CHILD_KINDS } from "../types.ts";
import { CONTEXT_MAX, GOAL_MAX } from "./brief.ts";
import type { Supervisor } from "./supervisor.ts";

export const LEAD_TOOLS: readonly string[] = ["delegate", "children", "steer_child", "stop_child", "merge_child"];
// Lead tools are deferred: the model loads them with tool_search when it needs them, so they cost no prompt otherwise.
const EXPOSURE = "deferred" as const;
export const CHILD_MESSAGE = "work-child";

export const DELEGATE_DESCRIPTION = "Hand a task to a headless child agent and keep working; its result arrives later as one message. kind implement: the child works in its own worktree and branch from your current HEAD (commit first), may change only `scope`, and must pass `acceptance`, which are targeted test commands, never full suites. kind read-only: it investigates in your directory without editing. Keep briefs small: a one-sentence goal, a tight scope, and a budget only as large as needed. `from: C-<n>` continues an earlier run's branch.";
export const CHILDREN_DESCRIPTION = "List your child runs: state, model, spend, diff against budget, acceptance results, and each child's note.";
export const STEER_DESCRIPTION = "Send guidance to a running child. By default it arrives at the child's next quiet moment; urgent: true delivers it right after the child's current tool calls.";
export const STOP_DESCRIPTION = "Stop a running child and end its process. Its worktree and branch are kept unless discard: true, which also removes them. Discard also works on finished runs.";
export const MERGE_DESCRIPTION = "Merge a done child whose acceptance passed into your branch (review its diff with git first), push without force, and create or update the draft PR. It never marks the PR ready or merges it.";

export type LeadToolDeps = { supervisor: Supervisor; merge: (leadSession: string, cwd: string, id: string) => Promise<string> };

const RUN_ID = Type.String({ pattern: "^C-\\d+$" });

function reply(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

export function registerLeadTools(pi: ExtensionAPI, deps: LeadToolDeps): void {
	pi.registerTool({
		name: "delegate",
		exposure: EXPOSURE,
		label: "Delegate",
		description: DELEGATE_DESCRIPTION,
		parameters: Type.Object({
			goal: Type.String({ minLength: 1, maxLength: GOAL_MAX }),
			kind: StringEnum([...CHILD_KINDS] as const),
			scope: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
			non_goals: Type.Optional(Type.Array(Type.String())),
			acceptance: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
			context: Type.Optional(Type.String({ maxLength: CONTEXT_MAX })),
			budget: Type.Optional(Type.Object({ lines: Type.Optional(Type.Integer({ minimum: 1 })), files: Type.Optional(Type.Integer({ minimum: 1 })) })),
			model: Type.Optional(Type.String({ minLength: 1 })),
			model_reason: Type.Optional(Type.String({ maxLength: 200 })),
			from: Type.Optional(RUN_ID),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = deps.supervisor.delegate(ctx.sessionManager.getSessionId(), ctx.cwd, params);
			return reply(result.message, { runId: result.ok ? result.run.id : null });
		},
	});

	pi.registerTool({
		name: "children",
		exposure: EXPOSURE,
		annotations: { readOnlyHint: true },
		label: "Children",
		description: CHILDREN_DESCRIPTION,
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			return reply(deps.supervisor.list(ctx.sessionManager.getSessionId()));
		},
	});

	pi.registerTool({
		name: "steer_child",
		exposure: EXPOSURE,
		label: "Steer Child",
		description: STEER_DESCRIPTION,
		parameters: Type.Object({ id: RUN_ID, text: Type.String({ minLength: 1, maxLength: CONTEXT_MAX }), urgent: Type.Optional(Type.Boolean()) }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return reply(await deps.supervisor.steer(ctx.sessionManager.getSessionId(), params.id, params.text, params.urgent === true));
		},
	});

	pi.registerTool({
		name: "stop_child",
		exposure: EXPOSURE,
		annotations: { destructiveHint: true },
		label: "Stop Child",
		description: STOP_DESCRIPTION,
		parameters: Type.Object({ id: RUN_ID, discard: Type.Optional(Type.Boolean()) }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return reply(await deps.supervisor.stop(ctx.sessionManager.getSessionId(), params.id, params.discard === true));
		},
	});

	pi.registerTool({
		name: "merge_child",
		exposure: EXPOSURE,
		annotations: { destructiveHint: true },
		label: "Merge Child",
		description: MERGE_DESCRIPTION,
		parameters: Type.Object({ id: RUN_ID }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return reply(await deps.merge(ctx.sessionManager.getSessionId(), ctx.cwd, params.id));
		},
	});
}
