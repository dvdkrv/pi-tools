import { spawn } from "node:child_process";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { captureItem } from "../src/work/capture.ts";
import type { ChildGuard } from "../src/work/children/child-guard.ts";
import { CHILD_RUN_ENV, createChildGuard, failClosedGuard, PARENT_PID_ENV } from "../src/work/children/child-guard.ts";
import { renderInterrupted } from "../src/work/children/format.ts";
import { runGit } from "../src/work/children/git.ts";
import { CHILD_MESSAGE, LEAD_TOOLS, registerLeadTools } from "../src/work/children/lead-tools.ts";
import { mergeChild } from "../src/work/children/merge.ts";
import type { SupervisorDeps } from "../src/work/children/supervisor.ts";
import { createSupervisor } from "../src/work/children/supervisor.ts";
import { startWatchdog } from "../src/work/children/watchdog.ts";
import { bashTimeoutMinutes, childrenConfig, DEFAULT_BASH_TIMEOUT_MINUTES, expandHome } from "../src/work/config.ts";
import type { GhRunner } from "../src/work/connectors/github.ts";
import { registerAgentJob } from "../src/work/jobs.ts";
import type { TmuxRunner } from "../src/work/planner.ts";
import { defaultTmux, launchPlanner, PLANNER_ENV, shellQuote } from "../src/work/planner.ts";
import { registerPlannerTools } from "../src/work/planner-tools.ts";
import { proposeCandidate } from "../src/work/proposals.ts";
import type { GitRunner } from "../src/work/rules.ts";
import { defaultGit, repoFromCwd } from "../src/work/rules.ts";
import type { Runtime } from "../src/work/runtime.ts";
import { openRuntime } from "../src/work/runtime.ts";
import { errorMessage } from "../src/work/secrets.ts";
import type { SignalSource } from "../src/work/session-tracker.ts";
import { createSessionTracker, shutdownIsClean, watchSignals } from "../src/work/session-tracker.ts";
import { syncAll } from "../src/work/sync.ts";
import { popupArgs, tmuxRunner } from "../src/work/tmux.ts";
import { openCandidates } from "../src/work/triage.ts";
import type { TriageUiContext } from "../src/work/triage-ui.ts";
import { runTriageUi } from "../src/work/triage-ui.ts";
import { DECLARED_STATUSES, JOB_KINDS } from "../src/work/types.ts";
import { recordUsage } from "../src/work/usage.ts";

export type WorkExtensionOptions = {
	runtime?: () => Runtime;
	repoFromCwd?: (cwd: string) => string | undefined;
	env?: NodeJS.ProcessEnv;
	tmux?: TmuxRunner;
	git?: GitRunner;
	pid?: number;
	signals?: SignalSource;
	popup?: (args: string[]) => void;
	childGit?: GitRunner;
	watchdog?: typeof startWatchdog;
	supervisor?: Partial<Omit<SupervisorDeps, "store" | "config" | "notify">>;
	gh?: GhRunner;
};

export const PROPOSE_DESCRIPTION = "Propose a follow-up for the user's work triage inbox. Use only for work outside your current task's scope, or for work you would otherwise leave as \"not done yet\" at the end of the session. Do not propose normal progress on your own task. The user reviews every proposal; this tool cannot create items, change status, or contact Jira.";

export const SESSION_STATUS_DESCRIPTION = "Write your complete reply to the user as visible text first; the user cannot see your thinking. Then, as the very last step of the turn, declare this session's state: `needs-me` when you are asking the user a question or need a decision (note: the question), `waiting-external` when blocked on CI, review, a deploy, or another person (note: what and why), `done` when the task is complete (note: one-line outcome). Call at most once per turn.";

export const JOB_REGISTER_DESCRIPTION = "Register a background job you started, such as a cron entry or a long-running process, so the user can see its health on the work dashboard. Give a check_command that exits 0 when the job is healthy, and a stop_command when stopping needs more than SIGTERM to pid. Registering the same name again updates the job.";

const WORK_BIN = fileURLToPath(new URL("../bin/work.ts", import.meta.url));

// Aliases do not reach tmux popups, so the popup runs Node and bin/work.ts by absolute path.
export function dashCommand(execPath: string = process.execPath): string {
	const node = /^node(\.exe)?$/.test(basename(execPath)) ? execPath : "node";
	return `${shellQuote(node)} ${shellQuote(WORK_BIN)} dash`;
}

function openPopup(args: string[]): void {
	spawn("tmux", args, { stdio: "ignore", detached: true }).unref();
}

type StatusContext = { ui: { setStatus: (key: string, text: string | undefined) => void } };

export function createWorkExtension(options: WorkExtensionOptions = {}) {
	return function workExtension(pi: ExtensionAPI): void {
		let runtime: Runtime | undefined;
		const rt = (): Runtime => (runtime ??= (options.runtime ?? (() => openRuntime()))());
		const track = (action: string, context: Record<string, unknown> = {}): void => {
			try {
				recordUsage(rt(), "pi", action, context);
			} catch {
				// Usage is best effort.
			}
		};
		const repoOf = options.repoFromCwd ?? ((cwd: string) => repoFromCwd(cwd));
		const env = options.env ?? process.env;
		const sessionTmux = options.tmux ?? tmuxRunner();
		let warn: (message: string) => void = () => {};
		const tracker = createSessionTracker({
			store: () => rt().store,
			pid: options.pid ?? process.pid,
			env,
			tmux: sessionTmux,
			git: options.git ?? defaultGit,
			warn: (message) => warn(message),
			onResponded: (seconds) => track("session.responded", { seconds }),
		});
		let signalled = false;
		let unwatch: (() => void) | undefined;
		// Child mode: guards and a parent watchdog, active only when a lead started this session.
		const childRunId = env[CHILD_RUN_ENV]?.trim() || undefined;
		let guard: ChildGuard | undefined = childRunId ? failClosedGuard("Blocked: child guards have not started yet.") : undefined;
		// Whether the current agent run has shown the user any non-empty text (see session_status).
		let visibleTextThisRun = false;
		let stopWatchdog: (() => void) | undefined;
		const startChild = (ctx: ExtensionContext): void => {
			if (!childRunId) return;
			try {
				const r = rt();
				const run = r.store.getChildRun(childRunId);
				if (!run) throw new Error(`unknown child run ${childRunId}`);
				guard = createChildGuard({
					run,
					config: childrenConfig(r.config),
					cwd: ctx.cwd,
					git: options.childGit ?? runGit,
					record: (patch) => {
						try {
							rt().store.updateChildRun(run.id, patch);
						} catch {
							// Guards keep their state in memory; the next update records it again.
						}
					},
					abort: () => ctx.abort(),
				});
			} catch (error) {
				guard = failClosedGuard(`Blocked: the work registry is unavailable (${errorMessage(error)}), so child guards cannot run. End with session_status.`);
			}
			stopWatchdog ??= (options.watchdog ?? startWatchdog)(
				() => {
					ctx.abort();
					ctx.shutdown();
				},
				{ parentPid: Number(env[PARENT_PID_ENV]) || undefined },
			);
		};
		if (childRunId) {
			pi.on("tool_call", async (event) => guard?.toolCall(event.toolName, event.input as Record<string, unknown>));
		} else {
			// Every other session gets a default bash timeout, so a hung command cannot hold the session forever.
			pi.on("tool_call", async (event) => {
				if (event.toolName !== "bash") return undefined;
				const input = event.input as Record<string, unknown>;
				if (typeof input.timeout === "number" && input.timeout > 0) return undefined;
				let minutes = DEFAULT_BASH_TIMEOUT_MINUTES;
				try {
					minutes = bashTimeoutMinutes(rt().config);
				} catch {
					// Without the registry the default still applies.
				}
				input.timeout = Math.max(1, Math.round(minutes * 60));
				return undefined;
			});
		}
		if (childRunId) {
			pi.on("tool_result", async (event) => {
				const warning = guard?.toolResult(event.toolName);
				return warning ? { content: [...event.content, { type: "text" as const, text: warning }] } : undefined;
			});
		}
		// Lead mode: delegation tools in every session that is not itself a child (only TUI sessions keep them active).
		const notifyLead = (text: string): void => {
			pi.sendMessage({ customType: CHILD_MESSAGE, content: text, display: true }, { deliverAs: "followUp", triggerTurn: true });
		};
		const supervisor = childRunId
			? undefined
			: createSupervisor({ store: () => rt().store, config: () => childrenConfig(rt().config), notify: notifyLead, pid: options.pid, ...options.supervisor });
		if (supervisor) {
			registerLeadTools(pi, {
				supervisor,
				merge: (leadSession, cwd, id) => {
					const r = rt();
					return mergeChild({ store: r.store, config: childrenConfig(r.config), accounts: r.config.github.accounts, gh: options.gh }, leadSession, cwd, id);
				},
			});
		}
		const startLead = (ctx: ExtensionContext): void => {
			if (!supervisor) return;
			if (ctx.mode !== "tui") {
				pi.setActiveTools(pi.getActiveTools().filter((name) => !LEAD_TOOLS.includes(name)));
				return;
			}
			try {
				const r = rt();
				for (const warning of r.warnings) if (warning.startsWith("children")) ctx.ui.notify(warning, "warning");
				const interrupted = supervisor.recover(ctx.sessionManager.getSessionId());
				if (interrupted.length > 0) notifyLead(renderInterrupted(interrupted));
			} catch {
				// The session tracker already warns once when the registry fails.
			}
		};

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
				track("todo");
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

		pi.registerTool({
			name: "session_status",
			label: "Session Status",
			description: SESSION_STATUS_DESCRIPTION,
			parameters: Type.Object({
				status: StringEnum([...DECLARED_STATUSES] as const),
				note: Type.String({ minLength: 1, maxLength: 200 }),
			}),
			async execute(_toolCallId, params) {
				const recorded = tracker.declare(params.status, params.note);
				// Models often draft the reply only in thinking and then call this tool; make them write it.
				const reminder = visibleTextThisRun ? "" : " Your reply is not visible yet: the user cannot see your thinking. Write your full answer now.";
				const text = recorded ? `Recorded ${params.status}.${reminder}` : `Session status is not being recorded for this session.${reminder}`;
				return { content: [{ type: "text", text }], details: { recorded } };
			},
		});

		pi.registerTool({
			name: "job_register",
			label: "Job Register",
			description: JOB_REGISTER_DESCRIPTION,
			parameters: Type.Object({
				name: Type.String({ minLength: 1, maxLength: 80 }),
				kind: StringEnum([...JOB_KINDS] as const),
				cwd: Type.String({ minLength: 1 }),
				schedule: Type.Optional(Type.String({ maxLength: 100 })),
				pid: Type.Optional(Type.Integer({ minimum: 1 })),
				check_command: Type.Optional(Type.String({ maxLength: 1000 })),
				stop_command: Type.Optional(Type.String({ maxLength: 1000 })),
				log_path: Type.Optional(Type.String({ maxLength: 500 })),
				relates_to: Type.Optional(Type.String()),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const result = registerAgentJob(rt().store, params, ctx.sessionManager.getSessionId());
				return { content: [{ type: "text", text: result.message }], details: { jobId: result.job.id, created: result.created } };
			},
		});

		pi.registerCommand("triage", {
			description: "Review the work triage inbox",
			handler: async (_args, ctx) => {
				track("triage");
				if (ctx.mode !== "tui") {
					ctx.ui.notify("Triage needs the interactive terminal; run `work triage` in a shell", "warning");
					return;
				}
				await runTriageUi(ctx as unknown as TriageUiContext, rt());
				refreshBadge(ctx);
			},
		});

		if (env[PLANNER_ENV] === "1") registerPlannerTools(pi, rt);

		pi.registerCommand("today", {
			description: "Sync, triage, then open today's planner session",
			handler: async (_args, ctx) => {
				track("today");
				try {
					const r = rt();
					const report = await syncAll(r.store, r.config, { jira: r.jira, gh: r.gh, backupDir: r.backupDir });
					for (const warning of report.warnings) ctx.ui.notify(warning, "warning");
					if (ctx.mode === "tui" && openCandidates(r.store).length > 0) await runTriageUi(ctx as unknown as TriageUiContext, r);
					const result = launchPlanner({ store: r.store, cwd: expandHome(r.config.plannerCwd ?? "~"), env, tmux: options.tmux ?? defaultTmux, now: r.store.clock() });
					ctx.ui.notify(result.message, "info");
					refreshBadge(ctx);
				} catch (error) {
					ctx.ui.notify(errorMessage(error), "error");
				}
			},
		});

		pi.registerCommand("dash", {
			description: "Open the work dashboard in a tmux popup",
			handler: async (_args, ctx) => {
				track("dash");
				if (!env.TMUX) {
					ctx.ui.notify("/dash needs tmux; run `work dash` in a terminal instead", "warning");
					return;
				}
				try {
					(options.popup ?? openPopup)(popupArgs(dashCommand()));
				} catch (error) {
					ctx.ui.notify(errorMessage(error), "error");
				}
			},
		});

		pi.on("session_start", async (_event, ctx) => {
			refreshBadge(ctx);
			warn = (message) => ctx.ui.notify(message, "warning");
			unwatch ??= watchSignals(options.signals ?? (process as unknown as SignalSource), () => {
				signalled = true;
			});
			tracker.start({
				id: ctx.sessionManager.getSessionId(),
				file: ctx.sessionManager.getSessionFile() ?? null,
				cwd: ctx.cwd,
				name: ctx.sessionManager.getSessionName() ?? null,
				mode: ctx.mode,
			});
			startChild(ctx);
			startLead(ctx);
		});
		pi.on("input", async (event) => {
			tracker.input(event.text, event.source);
		});
		pi.on("agent_start", async () => {
			visibleTextThisRun = false;
			tracker.agentStart();
		});
		pi.on("message_end", async (event) => {
			const message = event.message as unknown as { role?: string; content?: unknown; usage?: Usage };
			if (message.role !== "assistant") return;
			if (Array.isArray(message.content) && message.content.some((part) => {
				const block = part as { type?: string; text?: string };
				return block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0;
			})) visibleTextThisRun = true;
			if (childRunId && message.usage) guard?.assistantCost(message.usage);
		});
		pi.on("agent_end", async (event) => {
			tracker.agentEnd(event.messages);
			guard?.agentEnd();
		});
		pi.on("session_info_changed", async (event) => tracker.rename(event.name ?? null));
		pi.on("session_shutdown", async (event) => {
			// Pi's own signal handler starts shutdown before this extension's listener runs; yield once so it can.
			await Promise.resolve();
			tracker.shutdown(shutdownIsClean({ reason: event.reason, signalled, pane: tracker.pane, tmux: sessionTmux }));
			unwatch?.();
			unwatch = undefined;
			stopWatchdog?.();
			stopWatchdog = undefined;
			await supervisor?.shutdownAll();
		});
	};
}

export default createWorkExtension();
