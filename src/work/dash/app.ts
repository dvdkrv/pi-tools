import type { JobDeps } from "../jobs.ts";
import { checkJobs, checkStaleJobs, isStale, jobDetails, stopJob } from "../jobs.ts";
import type { KeyState, Move } from "../keymap.ts";
import { decodeKey, INITIAL_KEY_STATE, keyStep, moveIndex, splitKeys } from "../keymap.ts";
import type { PidReaders } from "../liveness.ts";
import { messageStateLabel } from "../messages.ts";
import type { TmuxRunner } from "../planner.ts";
import { shellQuote } from "../planner.ts";
import { reopenSession, runRestore, selectForRestore } from "../restore.ts";
import type { GitRunner } from "../rules.ts";
import { defaultGit, repoFromCwd } from "../rules.ts";
import type { Runtime } from "../runtime.ts";
import { errorMessage } from "../secrets.ts";
import type { TmuxPane } from "../tmux.ts";
import { jumpToPane, listPanes } from "../tmux.ts";
import { formatTranscript, readTranscript } from "../transcript.ts";
import type { TriageActionUi, TriageKey } from "../triage-actions.ts";
import { runTriageAction, TRIAGE_ACTIONS } from "../triage-actions.ts";
import { candidateLabel, candidateSummary, openCandidates } from "../triage.ts";
import type { Candidate, Item, Job, MessageLogEntry } from "../types.ts";
import { OPEN_ITEM_STATUSES } from "../types.ts";
import { recordUsage } from "../usage.ts";
import type { HostSample, HostSnapshot } from "./host.ts";
import { collectHost } from "./host.ts";
import type { DashModel, DashRow, SessionEntry } from "./model.ts";
import { allRows, buildDashModel, loadSessions } from "./model.ts";
import type { Terminal } from "./terminal.ts";
import { frame } from "./terminal.ts";
import type { Style } from "./text.ts";
import { ansiStyle, fit, oneLine, truncate } from "./text.ts";
import { filterModel, renderDash } from "./view.ts";
import type { Modal } from "./widgets.ts";
import { confirmBox, fuzzyPicker, messageBox, selectList, textPrompt } from "./widgets.ts";

export type DashDeps = {
	runtime: Runtime;
	terminal: Terminal;
	tmux: TmuxRunner;
	insideTmux: boolean;
	readers?: PidReaders;
	style?: Style;
	refreshMs?: number;
	bootId?: () => string | undefined;
	fileExists?: (path: string) => boolean;
	pi?: string;
	kill?: (pid: number, signal: NodeJS.Signals) => void;
	jobs?: JobDeps;
	// undefined collects host metrics with collectHost; null turns the host panel off.
	host?: ((prev: HostSample | undefined) => Promise<HostSnapshot>) | null;
	// Finds the repository that names a session whose tmux window has a default name.
	git?: GitRunner;
};
export type DashResult = { print?: string };
type TriageState = { candidates: Candidate[]; index: number; keys: KeyState };

export const MAIN_ACTIONS: readonly string[] = ["L", "c", "x", "D", "R", "?"];
export const CONFIRM_ACTIONS: readonly string[] = ["x", "D"];
export const HELP_TEXT = [
	"j / k            down / up",
	"gg / G           first / last row",
	"Ctrl-d / Ctrl-u  half page down / up",
	"Tab / Shift-Tab  next / previous section (also ] and [)",
	"/ then n / N     filter as you type, then next / previous match; Esc clears",
	"Enter            jump to a session, reopen a closed or crashed one, open triage,",
	"                 show a child transcript, job details, or a message",
	"L                link the session to an item",
	"c                check the selected job now",
	"x then y         stop the selected job, or a running child agent (SIGTERM)",
	"D then y         delete a stopped job, or a closed or crashed session record",
	"R                refresh and re-run stale job checks",
	"?                this help",
	"q / Esc          close",
].join("\n");

const DEFAULT_REFRESH_MS = 5000;
const CPU_WARMUP_MS = 1000;
const TRIAGE_PAGE = 10;
const TRIAGE_HINTS = "j/k move · a accept · m merge · d dismiss · z snooze · A all from source · p promote · enter details · esc back";
const itemLabel = (item: Item): string => `${item.id} ${item.title}  #${item.project}`;

function messageDetail(entry: MessageLogEntry): string {
	const at = new Date(entry.at);
	const pad = (value: number): string => String(value).padStart(2, "0");
	const time = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
	return `${time}  ${oneLine(entry.senderName)} → ${oneLine(entry.recipientName)}  ${entry.kind}  ${oneLine(messageStateLabel(entry.state))}\n${entry.body}`;
}

function jobOf(row: DashRow | undefined): Job | undefined {
	return row?.kind === "job" || row?.kind === "alert" ? row.job : undefined;
}

function confirmPrompt(key: string, row: DashRow | undefined): string {
	const job = jobOf(row);
	if (job) return key === "x" ? `Stop ${job.id} ${job.name}? y to confirm, any other key cancels` : `Delete stopped job ${job.id}? y to confirm, any other key cancels`;
	return key === "x" ? "Stop this child agent with SIGTERM? y to confirm, any other key cancels" : "Delete this session record? y to confirm, any other key cancels";
}

export function runDash(deps: DashDeps): Promise<DashResult> {
	const { store } = deps.runtime;
	const term = deps.terminal;
	const style = deps.style ?? ansiStyle;
	const kill = deps.kill ?? ((pid: number, signal: NodeJS.Signals) => {
		process.kill(pid, signal);
	});
	const track = (action: string, context: Record<string, unknown> = {}): void => recordUsage(deps.runtime, "dash", action, context);
	const openedAt = store.clock().getTime();
	let moves = 0;
	let sessions: SessionEntry[] = [];
	let model: DashModel = buildDashModel({ sessions, triageCount: 0, now: store.clock() });
	let panes: TmuxPane[] | undefined;
	let keys: KeyState = INITIAL_KEY_STATE;
	let selected: string | null = null;
	let confirmTarget: string | null = null;
	let message = "";
	let busy = false;
	let closed = false;
	let triage: TriageState | undefined;
	let checking = false;
	let refreshedAt: Date | undefined;
	let stale = false;
	const collector = deps.host === undefined ? (prev: HostSample | undefined) => collectHost(prev) : deps.host;
	let host: HostSnapshot | undefined;
	let collecting = false;
	const checkAbort = new AbortController();
	const jobDeps = (): JobDeps => ({ ...deps.jobs, signal: checkAbort.signal });
	const modals: Modal[] = [];
	let timer: ReturnType<typeof setInterval> | undefined;
	let cpuWarmupTimer: ReturnType<typeof setTimeout> | undefined;
	let resolveRun: (result: DashResult) => void = () => {};
	const finished = new Promise<DashResult>((resolve) => {
		resolveRun = resolve;
	});

	// git is slow and a cwd's repository does not change, so each cwd is asked once per dashboard.
	const repos = new Map<string, string | null>();
	const repoOf = (cwd: string): string | null => {
		if (!repos.has(cwd)) repos.set(cwd, repoFromCwd(cwd, deps.git ?? defaultGit) ?? null);
		return repos.get(cwd) ?? null;
	};
	const visibleRows = (): DashRow[] => allRows(filterModel(model, keys.filter));
	const selectedRow = (): DashRow | undefined => visibleRows().find((row) => row.key === selected);
	const sessionOf = (row: DashRow | undefined): SessionEntry | undefined => (row?.kind === "session" ? row.session : undefined);

	function reload(): void {
		panes = listPanes(deps.tmux);
		sessions = loadSessions(store, panes, deps.readers, repoOf);
		const triageCount = deps.runtime.config.dashboard?.showTriage === true ? openCandidates(store).length : 0;
		const now = store.clock();
		const messages = store.listMessageLog({ since: new Date(now.getTime() - 86_400_000).toISOString(), limit: 20 });
		model = buildDashModel({ sessions, triageCount, jobs: store.listJobs(), messages, now });
		const rows = visibleRows();
		if (!rows.some((row) => row.key === selected)) selected = rows[0]?.key ?? null;
		refreshedAt = store.clock();
		stale = false;
	}

	function safeReload(): void {
		try {
			reload();
		} catch (error) {
			stale = true;
			message = errorMessage(error);
		}
	}

	// Host collection is async and never fatal: one in flight at a time, and the frame is redrawn when it lands.
	function collectHostNow(): void {
		if (!collector || closed || collecting) return;
		const first = host === undefined;
		collecting = true;
		collector(host?.sample)
			.then((snapshot) => {
				host = snapshot;
				if (first && snapshot.cpuPercent === null && !closed) {
					cpuWarmupTimer = setTimeout(() => {
						cpuWarmupTimer = undefined;
						collectHostNow();
					}, CPU_WARMUP_MS);
				}
			})
			.catch(() => {})
			.finally(() => {
				collecting = false;
				if (!closed) render();
			});
	}

	function triageLines(state: TriageState, width: number, height: number): string[] {
		const visible = Math.max(1, Math.floor((height - 3) / 2));
		const start = Math.max(0, Math.min(state.index - Math.floor(visible / 2), state.candidates.length - visible));
		const lines = [style.bold(truncate(`Triage (${state.candidates.length} open)`, width))];
		for (let i = start; i < Math.min(state.candidates.length, start + visible); i++) {
			const candidate = state.candidates[i];
			const label = oneLine(candidateLabel(candidate));
			lines.push(i === state.index ? style.inverse(fit(`> ${label}`, width)) : truncate(`  ${label}`, width));
			lines.push(style.dim(truncate(`    ${oneLine(candidateSummary(candidate))}`, width)));
		}
		lines.push(style.dim(truncate(TRIAGE_HINTS, width)), truncate(oneLine(message), width));
		return lines;
	}

	function render(): void {
		if (closed) return;
		const width = term.columns();
		const height = term.rows();
		const top = modals.at(-1);
		const lines = top
			? top.lines(width, height, style)
			: triage
				? triageLines(triage, width, height)
				: renderDash(model, { selected, filter: keys.filter, editing: keys.editing, message, refreshedAt, stale }, width, height, style, host);
		term.write(frame(lines));
	}

	function finish(result: DashResult): void {
		if (closed) return;
		closed = true;
		if (timer) clearInterval(timer);
		if (cpuWarmupTimer) clearTimeout(cpuWarmupTimer);
		checkAbort.abort();
		track("close", { moves, seconds: Math.round((store.clock().getTime() - openedAt) / 1000) });
		term.stop();
		resolveRun(result);
	}

	function ask<T>(make: (resolve: (value: T) => void) => Modal): Promise<T> {
		return new Promise<T>((resolve) => {
			const modal = make((value) => {
				const index = modals.indexOf(modal);
				if (index >= 0) modals.splice(index, 1);
				resolve(value);
				render();
			});
			modals.push(modal);
			render();
		});
	}

	function perform(task: () => Promise<void> | void): void {
		busy = true;
		Promise.resolve()
			.then(task)
			.catch((error: unknown) => {
				message = errorMessage(error);
			})
			.finally(() => {
				busy = false;
				if (closed) return;
				safeReload();
				render();
			});
	}

	// Checks run in the background so the dashboard stays responsive; results re-render when they land.
	function backgroundCheck(targets?: Job[]): void {
		if (checking) {
			if (targets) message = "A check is already running";
			return;
		}
		// With nothing stale, stay idle so an immediate `c` is not refused as "already running".
		if (!targets && !store.listJobs({ activeOnly: true }).some((job) => isStale(job, store.clock()))) return;
		checking = true;
		const run = targets ? checkJobs(store, targets, jobDeps()) : checkStaleJobs(store, jobDeps());
		run
			.then((checked) => {
				if (targets) message = checked.map((job) => `${job.id} ${job.lastCheckStatus}: ${job.lastCheckOutput ?? ""}`).join("; ");
			})
			.catch((error: unknown) => {
				message = errorMessage(error);
			})
			.finally(() => {
				checking = false;
				if (closed) return;
				safeReload();
				render();
			});
	}

	const triageUi: TriageActionUi = {
		input: (title, placeholder) => ask<string | undefined>((resolve) => textPrompt(title, placeholder ?? "", resolve)),
		select: (title, options) => ask<string | undefined>((resolve) => selectList(title, options, resolve)),
		confirm: (title, text) => ask<boolean>((resolve) => confirmBox(title, text, resolve)),
		notify: (text) => {
			if (text.includes("\n")) void ask<void>((resolve) => messageBox("Details", text, resolve));
			else message = text;
		},
		pickItem: (title, items) => ask<Item | undefined>((resolve) => fuzzyPicker(title, items, itemLabel, resolve)),
	};

	function move(to: Move): void {
		const rows = visibleRows();
		if (rows.length === 0) return;
		if (to === "next-section" || to === "prev-section") {
			const sections = filterModel(model, keys.filter).sections.filter((section) => section.rows.length > 0);
			const current = Math.max(0, sections.findIndex((section) => section.rows.some((row) => row.key === selected)));
			const target = sections[to === "next-section" ? Math.min(sections.length - 1, current + 1) : Math.max(0, current - 1)];
			selected = target?.rows[0]?.key ?? selected;
			return;
		}
		const index = Math.max(0, rows.findIndex((row) => row.key === selected));
		selected = rows[moveIndex(index, rows.length, to, Math.max(2, term.rows() - 3))].key;
	}

	function match(direction: 1 | -1): void {
		const rows = visibleRows();
		if (rows.length === 0) return;
		const index = rows.findIndex((row) => row.key === selected);
		selected = rows[(index + direction + rows.length) % rows.length].key;
	}

	function jump(pane: string): void {
		track("jump");
		const result = jumpToPane(deps.tmux, pane, deps.insideTmux);
		finish(result.kind === "print" ? { print: result.command } : {});
	}

	async function showTranscript(session: SessionEntry): Promise<void> {
		if (!session.file) {
			message = "This session has no session file";
			return;
		}
		const text = formatTranscript(readTranscript(session.file));
		track("transcript");
		await ask<void>((resolve) => messageBox(`Transcript: ${session.name ?? session.id} (read-only)`, text, resolve, { atEnd: true }));
	}

	function openTriage(): void {
		const candidates = openCandidates(store);
		if (candidates.length === 0) {
			message = "Triage inbox is empty";
			return;
		}
		track("triage");
		triage = { candidates, index: 0, keys: INITIAL_KEY_STATE };
	}

	function refreshTriage(): void {
		if (!triage) return;
		const candidates = openCandidates(store);
		if (candidates.length === 0) {
			triage = undefined;
			message = "Triage inbox is empty";
			return;
		}
		triage = { ...triage, candidates, index: Math.min(triage.index, candidates.length - 1) };
	}

	async function activate(): Promise<void> {
		const row = selectedRow();
		if (!row) return;
		if (row.kind === "triage") {
			openTriage();
			return;
		}
		if (row.kind === "job" || row.kind === "alert") {
			const job = row.job;
			track("details");
			await ask<void>((resolve) => messageBox(`Job ${job.id}`, jobDetails(store, job, store.clock()), resolve));
			return;
		}
		if (row.kind === "message") {
			const thread = store.messageThread(row.message.id);
			if (!thread) {
				message = "This message is no longer available";
				return;
			}
			const sections = [messageDetail(thread.message)];
			if (thread.message.kind === "reply" && thread.request) sections.push("--- request ---", messageDetail(thread.request));
			if (thread.message.kind === "request") {
				for (const reply of thread.replies) sections.push("--- reply ---", messageDetail(reply));
			}
			track("message");
			await ask<void>((resolve) => messageBox("Message (read-only)", sections.join("\n\n"), resolve));
			return;
		}
		if (row.kind === "ended" || row.kind === "older") return;
		const session = row.session;
		if (session.parentSession || (session.liveness === "live" && !session.tmuxPane)) {
			await showTranscript(session);
			return;
		}
		if (session.liveness === "live" && session.tmuxPane) {
			jump(session.tmuxPane);
			return;
		}
		if (!panes) {
			if (!session.file) throw new Error("This session has no session file to reopen");
			finish({ print: `cd ${shellQuote(session.cwd)} && ${deps.pi ?? "pi"} --session ${shellQuote(session.file)}` });
			return;
		}
		track("reopen");
		jump(reopenSession(store, session, deps.tmux, panes, { fileExists: deps.fileExists, pi: deps.pi }));
	}

	async function runAction(key: string): Promise<void> {
		if (key === "R") {
			message = "Refreshed";
			track("refresh");
			collectHostNow();
			backgroundCheck();
			return;
		}
		if (key === "c") {
			const job = jobOf(selectedRow());
			if (!job) {
				message = "c checks the selected job";
				return;
			}
			message = `Checking ${job.id}…`;
			track("check");
			backgroundCheck([job]);
			return;
		}
		if (key === "?") {
			track("help");
			await ask<void>((resolve) => messageBox("Keys", HELP_TEXT, resolve));
			return;
		}
		if (key === "L") {
			const row = selectedRow();
			if (row?.kind === "ended") return;
			const session = sessionOf(row);
			if (!session) {
				message = "L links a session to an item";
				return;
			}
			const item = await ask<Item | undefined>((resolve) => fuzzyPicker("Link session to item", store.listItems({ statuses: OPEN_ITEM_STATUSES }), itemLabel, resolve));
			if (!item) return;
			store.linkSession(session.id, item.id, "manual", "user");
			track("link");
			message = `Linked to ${item.id}`;
		}
	}

	function canConfirm(key: string): boolean {
		const row = selectedRow();
		if (row?.kind === "ended") return false;
		const job = jobOf(row);
		if (job) {
			if (key === "x" && !job.stoppedAt) return true;
			if (key === "D" && job.stoppedAt) return true;
			message = key === "x" ? "This job is already stopped" : "Stop the job before deleting it";
			return false;
		}
		const session = sessionOf(row);
		if (key === "D" && session && session.liveness !== "live") return true;
		if (key === "x" && session?.parentSession && session.alive) return true;
		message = key === "D" ? "D deletes only closed or crashed sessions" : "x stops only running child agents";
		return false;
	}

	async function runConfirmed(key: string): Promise<void> {
		const row = allRows(model).find((candidate) => candidate.key === confirmTarget);
		confirmTarget = null;
		const job = jobOf(row);
		if (job) {
			if (key === "x") {
				const stopped = await stopJob(store, job, "user", deps.jobs);
				track("stop", { target: "job" });
				message = `Stopped ${stopped.job.id} ${stopped.job.name}${stopped.note}`;
			} else {
				store.deleteJob(job.id, "user");
				track("delete", { target: "job" });
				message = `Deleted ${job.id}`;
			}
			return;
		}
		const session = sessionOf(row);
		if (!session) {
			message = "That row is gone; nothing was changed";
			return;
		}
		if (key === "D") {
			store.deleteSession(session.id);
			track("delete", { target: "session" });
			message = "Session record deleted";
			return;
		}
		if (key === "x" && session.pid) {
			// The dashboard cannot reach the lead's RPC pipe: it records the stop, and the lead reports it.
			const run = store.childRunForSession(session.id);
			if (run?.outcome === "running") store.endChildRun(run.id, { outcome: "stopped", summary: "stopped from the dashboard" }, "user");
			try {
				kill(session.pid, "SIGTERM");
				track("stop", { target: "child" });
				message = `Sent SIGTERM to ${session.name ?? session.id}`;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
				message = "The child had already exited";
			}
		}
	}

	function mainKey(key: string): void {
		const wasEditing = keys.editing;
		const step = keyStep(keys, key, { actions: MAIN_ACTIONS, confirm: CONFIRM_ACTIONS, filter: true });
		keys = step.state;
		const { action } = step;
		switch (action.type) {
			case "move":
				move(action.move);
				moves++;
				message = "";
				break;
			case "filter": {
				if (!wasEditing && action.editing) track("filter");
				const rows = visibleRows();
				if (!rows.some((row) => row.key === selected)) selected = rows[0]?.key ?? null;
				break;
			}
			case "match":
				match(action.direction);
				break;
			case "enter":
				perform(activate);
				break;
			case "close":
				finish({});
				return;
			case "action": {
				const actionKey = action.key;
				perform(() => runAction(actionKey));
				break;
			}
			case "confirming":
				if (canConfirm(action.key)) {
					confirmTarget = selected;
					message = confirmPrompt(action.key, selectedRow());
				} else {
					keys = { ...keys, confirming: null };
				}
				break;
			case "confirmed": {
				const confirmedKey = action.key;
				perform(() => runConfirmed(confirmedKey));
				break;
			}
			case "cancelled":
				confirmTarget = null;
				message = "Cancelled";
				break;
			default:
				break;
		}
		render();
	}

	function triageKey(state: TriageState, key: string): void {
		const step = keyStep(state.keys, key, { actions: TRIAGE_ACTIONS });
		state.keys = step.state;
		const { action } = step;
		if (action.type === "close") {
			triage = undefined;
			message = "";
		} else if (action.type === "move") {
			state.index = moveIndex(state.index, state.candidates.length, action.move, TRIAGE_PAGE);
		} else if (action.type === "enter" || action.type === "action") {
			const triageAction: TriageKey = action.type === "enter" ? "enter" : (action.key as TriageKey);
			const candidate = state.candidates[state.index];
			perform(async () => {
				await runTriageAction(triageUi, deps.runtime, triageAction, candidate);
				refreshTriage();
			});
		}
		render();
	}

	function onKey(key: string): void {
		const top = modals.at(-1);
		if (top) {
			top.handle(key);
			render();
			return;
		}
		if (busy) return;
		if (triage) triageKey(triage, key);
		else mainKey(key);
	}

	function autoRestore(): void {
		if (selectForRestore(sessions, store.clock(), deps.fileExists).selected.length === 0) return;
		const report = runRestore("auto", { store, tmux: deps.tmux, readers: deps.readers, bootId: deps.bootId, fileExists: deps.fileExists, pi: deps.pi });
		if (!report.ran) return;
		track("restore", { placed: report.placed.length, failed: report.failed.length });
		const count = report.placed.length;
		message = `Restored ${count} crashed session${count === 1 ? "" : "s"}${report.failed.length ? `; ${report.failed.length} failed` : ""}`;
		reload();
	}

	term.onInput((data) => {
		for (const chunk of splitKeys(data)) {
			if (closed) return;
			const key = decodeKey(chunk);
			if (key) onKey(key);
		}
	});
	term.onResize(render);
	track("open");
	term.start();
	try {
		reload();
		autoRestore();
	} catch (error) {
		message = errorMessage(error);
	}
	render();
	collectHostNow();
	backgroundCheck();
	const refreshMs = deps.refreshMs ?? DEFAULT_REFRESH_MS;
	if (refreshMs > 0) {
		timer = setInterval(() => {
			if (busy || closed || modals.length > 0 || keys.confirming || triage) return;
			safeReload();
			collectHostNow();
			render();
		}, refreshMs);
	}
	return finished;
}
