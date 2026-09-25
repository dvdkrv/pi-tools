import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { captureItem } from "../src/work/capture.ts";
import { proposeCandidate } from "../src/work/proposals.ts";
import { repoFromCwd } from "../src/work/rules.ts";
import type { Runtime } from "../src/work/runtime.ts";
import { openRuntime } from "../src/work/runtime.ts";
import { errorMessage } from "../src/work/secrets.ts";
import { openCandidates } from "../src/work/triage.ts";
import type { TriageUiContext } from "../src/work/triage-ui.ts";
import { runTriageUi } from "../src/work/triage-ui.ts";

export type WorkExtensionOptions = {
	runtime?: () => Runtime;
	repoFromCwd?: (cwd: string) => string | undefined;
	env?: NodeJS.ProcessEnv;
};

export const PROPOSE_DESCRIPTION = "Propose a follow-up for the user's work triage inbox. Use only for work outside your current task's scope, or for work you would otherwise leave as \"not done yet\" at the end of the session. Do not propose normal progress on your own task. The user reviews every proposal; this tool cannot create items, change status, or contact Jira.";

type StatusContext = { ui: { setStatus: (key: string, text: string | undefined) => void } };

export function createWorkExtension(options: WorkExtensionOptions = {}) {
	return function workExtension(pi: ExtensionAPI): void {
		let runtime: Runtime | undefined;
		const rt = (): Runtime => (runtime ??= (options.runtime ?? (() => openRuntime()))());
		const repoOf = options.repoFromCwd ?? ((cwd: string) => repoFromCwd(cwd));

		const refreshBadge = (ctx: StatusContext): void => {
			try {
				const count = openCandidates(rt().store).length;
				ctx.ui.setStatus("work", count > 0 ? `inbox ${count}` : undefined);
			} catch {
				ctx.ui.setStatus("work", undefined);
			}
		};

		pi.registerCommand("todo", {
			description: "Capture a work item: /todo <text> [#project] [due:<date>]",
			handler: async (args, ctx) => {
				const text = (args ?? "").trim();
				if (!text) {
					ctx.ui.notify("Usage: /todo <text> [#project] [due:<date>]", "warning");
					return;
				}
				try {
					const r = rt();
					const item = captureItem(r.store, text, { repo: repoOf(ctx.cwd), now: r.store.clock(), knownProjects: r.knownProjects(), rules: r.config.rules }, "user");
					ctx.ui.notify(`${item.id} added to ${item.project}`, "info");
				} catch (error) {
					ctx.ui.notify(errorMessage(error), "error");
				}
			},
		});

		pi.registerTool({
			name: "work_propose",
			label: "Work Propose",
			description: PROPOSE_DESCRIPTION,
			parameters: Type.Object({
				title: Type.String({ minLength: 3, maxLength: 120 }),
				reason: Type.String({ minLength: 1, maxLength: 500 }),
				evidence: Type.Optional(Type.String({ maxLength: 1000 })),
				project: Type.Optional(Type.String()),
				relates_to: Type.Optional(Type.String()),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const r = rt();
				const result = proposeCandidate(
					r.store,
					{ title: params.title, reason: params.reason, evidence: params.evidence, project: params.project, relatesTo: params.relates_to },
					{ sessionId: ctx.sessionManager.getSessionId(), repo: repoOf(ctx.cwd) ?? null },
					r.config,
				);
				refreshBadge(ctx);
				return { content: [{ type: "text", text: result.message }], details: { status: result.status, candidateId: result.candidate?.id ?? null } };
			},
		});

		pi.registerCommand("triage", {
			description: "Review the work triage inbox",
			handler: async (_args, ctx) => {
				if (ctx.mode !== "tui") {
					ctx.ui.notify("Triage needs the interactive terminal; run `work triage` in a shell", "warning");
					return;
				}
				await runTriageUi(ctx as unknown as TriageUiContext, rt());
				refreshBadge(ctx);
			},
		});

		pi.on("session_start", async (_event, ctx) => refreshBadge(ctx));
	};
}

export default createWorkExtension();
