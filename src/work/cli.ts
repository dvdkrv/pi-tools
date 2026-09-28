import { exportJsonl, importJsonl, writeRotatingBackup } from "./backup.ts";
import { captureItem, resolveDue } from "./capture.ts";
import { cliPromote, runCliTriage } from "./cli-triage.ts";
import { expandHome } from "./config.ts";
import { runDash } from "./dash/app.ts";
import type { Terminal } from "./dash/terminal.ts";
import { processTerminal } from "./dash/terminal.ts";
import { checkJobs, formatJob } from "./jobs.ts";
import type { PidReaders } from "./liveness.ts";
import type { TmuxRunner } from "./planner.ts";
import { defaultTmux, launchPlanner } from "./planner.ts";
import { recapRange, renderRecap } from "./recap.ts";
import { formatRestoreReport, runRestore } from "./restore.ts";
import type { RestoreMode } from "./restore.ts";
import { repoFromCwd as defaultRepoFromCwd } from "./rules.ts";
import type { Runtime } from "./runtime.ts";
import type { ItemPatch } from "./store.ts";
import { formatSyncReport, syncAll } from "./sync.ts";
import { tmuxRunner } from "./tmux.ts";
import { openCandidates } from "./triage.ts";
import type { Item, ItemStatus, Job, JobKind, WaitingOn } from "./types.ts";
import { ITEM_STATUSES, WAITING_ON } from "./types.ts";

export type CliIo = { out(text: string): void; err(text: string): void; ask(question: string): Promise<string> };
export type CliDeps = {
	runtime: () => Runtime;
	io: CliIo;
	cwd: string;
	env: NodeJS.ProcessEnv;
	repoFromCwd?: (cwd: string) => string | undefined;
	tmux?: TmuxRunner;
	readers?: PidReaders;
	bootId?: () => string | undefined;
	terminal?: Terminal;
};
export type CliCommand = { usage: string; run: (args: string[], deps: CliDeps) => Promise<number> };

export class UsageError extends Error {}

const DAY_MS = 86_400_000;

export function formatItem(item: Item, now: Date): string {
	const extras: string[] = [];
	if (item.pinned) extras.push("pinned");
	if (item.due) extras.push(`due ${item.due}`);
	if (item.status === "waiting" && item.waitingSince) {
		const days = Math.floor((now.getTime() - Date.parse(item.waitingSince)) / DAY_MS);
		extras.push(`waiting on ${item.waitingOn} ${days}d${item.waitingReason ? `: ${item.waitingReason}` : ""}`);
	}
	return `${item.id.padEnd(6)} ${item.status.padEnd(8)} ${item.title}${extras.length ? `  (${extras.join(", ")})` : ""}`;
}

export function parseAssignments(args: string[]): Record<string, string> {
	const out: Record<string, string> = {};
	let current: string | undefined;
	for (const arg of args) {
		const match = /^([a-z_]+)=(.*)$/.exec(arg);
		if (match) {
			current = match[1];
			out[current] = match[2];
		} else if (current) {
			out[current] += ` ${arg}`;
		} else {
			throw new UsageError(`Expected key=value, got: ${arg}`);
		}
	}
	return out;
}

function parseBoolean(value: string): boolean {
	if (["true", "yes", "y", "1", "on"].includes(value.toLowerCase())) return true;
	if (["false", "no", "n", "0", "off"].includes(value.toLowerCase())) return false;
	throw new UsageError(`Expected true or false, got: ${value}`);
}

export function parseFlags(args: string[], allowed: readonly string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (let i = 0; i < args.length; i += 2) {
		const match = /^--([a-z]+)$/.exec(args[i]);
		if (!match || !allowed.includes(match[1])) throw new UsageError(`Unknown option: ${args[i]}`);
		const value = args[i + 1];
		if (value === undefined) throw new UsageError(`--${match[1]} needs a value`);
		out[match[1]] = value;
	}
	return out;
}

export function patchFrom(assignments: Record<string, string>, now: Date): ItemPatch {
	const patch: ItemPatch = {};
	for (const [key, raw] of Object.entries(assignments)) {
		const value = raw.trim();
		switch (key) {
			case "status":
				if (!ITEM_STATUSES.includes(value as ItemStatus)) throw new UsageError(`status must be one of ${ITEM_STATUSES.join(", ")}`);
				patch.status = value as ItemStatus;
				break;
			case "waiting_on":
				if (!WAITING_ON.includes(value as WaitingOn)) throw new UsageError(`waiting_on must be one of ${WAITING_ON.join(", ")}`);
				patch.waitingOn = value as WaitingOn;
				break;
			case "reason":
				patch.waitingReason = value || null;
				break;
			case "due":
				patch.due = value === "none" || value === "" ? null : resolveDue(value, now);
				break;
			case "pinned":
				patch.pinned = parseBoolean(value);
				break;
			case "project":
				patch.project = value;
				break;
			case "title":
				patch.title = value;
				break;
			case "notes":
				patch.notes = value;
				break;
			default:
				throw new UsageError(`Unknown field: ${key}`);
		}
	}
	return patch;
}

const add: CliCommand = {
	usage: "add <text> [#project] [due:<date>]   Capture an item",
	async run(args, deps) {
		const text = args.join(" ").trim();
		if (!text) throw new UsageError("Usage: work add <text> [#project] [due:<date>]");
		const rt = deps.runtime();
		const repo = (deps.repoFromCwd ?? defaultRepoFromCwd)(deps.cwd);
		const item = captureItem(rt.store, text, { repo, now: rt.store.clock(), knownProjects: rt.knownProjects(), rules: rt.config.rules }, "user");
		deps.io.out(`${item.id} added to ${item.project}`);
		return 0;
	},
};

const list: CliCommand = {
	usage: "list [--all] [--project <slug>]      List open items",
	async run(args, deps) {
		const rt = deps.runtime();
		const all = args.includes("--all");
		const projectIndex = args.indexOf("--project");
		const project = projectIndex >= 0 ? args[projectIndex + 1] : undefined;
		const statuses: ItemStatus[] = all ? [...ITEM_STATUSES] : ["todo", "doing", "waiting"];
		const items = rt.store.listItems({ statuses, project });
		if (items.length === 0) {
			deps.io.out("No items");
			return 0;
		}
		const now = rt.store.clock();
		const lines: string[] = [];
		for (const p of rt.store.listProjects()) {
			const own = items.filter((item) => item.project === p.slug);
			if (own.length === 0) continue;
			lines.push(`${p.slug} (${p.title})`);
			for (const item of own) lines.push(`  ${formatItem(item, now)}`);
		}
		deps.io.out(lines.join("\n"));
		return 0;
	},
};

const show: CliCommand = {
	usage: "show <W-n>                           Show one item",
	async run(args, deps) {
		const rt = deps.runtime();
		const id = args[0];
		if (!id) throw new UsageError("Usage: work show <W-n>");
		const item = rt.store.getItem(id);
		if (!item) throw new UsageError(`Unknown item: ${id}`);
		const lines = [formatItem(item, rt.store.clock()), `  project: ${item.project}  origin: ${item.origin}  created: ${item.createdAt}`];
		if (item.notes) lines.push("  notes:", ...item.notes.split("\n").map((line) => `    ${line}`));
		const links = rt.store.listLinks(item.id);
		if (links.length) {
			lines.push("  links:");
			for (const link of links) lines.push(`    ${link.kind.padEnd(12)} ${link.key}  ${link.url ?? ""}${link.state ? `  ${JSON.stringify(link.state)}` : ""}`);
		}
		const events = rt.store.listEvents({ entityPrefix: `item:${item.id}` }).filter((event) => event.entity === `item:${item.id}`).slice(-10);
		lines.push("  history:");
		for (const event of events) lines.push(`    ${event.at}  ${event.actor.padEnd(12)} ${event.action}`);
		deps.io.out(lines.join("\n"));
		return 0;
	},
};

const set: CliCommand = {
	usage: "set <W-n> key=value...              status, waiting_on, reason, due, pinned, project, title, notes",
	async run(args, deps) {
		const [id, ...rest] = args;
		if (!id || rest.length === 0) throw new UsageError("Usage: work set <W-n> key=value...");
		const rt = deps.runtime();
		const updated = rt.store.updateItem(id, patchFrom(parseAssignments(rest), rt.store.clock()), "user");
		deps.io.out(formatItem(updated, rt.store.clock()));
		return 0;
	},
};

const project: CliCommand = {
	usage: "project [add <slug> <title> | set <slug> key=value...]  List or manage projects (status, epic, notes_path)",
	async run(args, deps) {
		const rt = deps.runtime();
		const [action, slug, ...rest] = args;
		if (!action) {
			const lines = rt.store.listProjects().map((p) => `${p.slug.padEnd(20)} ${p.status.padEnd(9)} ${p.title}${p.jiraEpic ? `  epic ${p.jiraEpic}` : ""}`);
			deps.io.out(lines.join("\n"));
			return 0;
		}
		if (action === "add") {
			const title = rest.join(" ").trim();
			if (!slug || !title) throw new UsageError("Usage: work project add <slug> <title>");
			if (rt.store.getProject(slug)) throw new UsageError(`Project ${slug} already exists`);
			rt.store.upsertProject({ slug, title }, "user");
			deps.io.out(`Project ${slug} added`);
			return 0;
		}
		if (action === "set") {
			const existing = slug ? rt.store.getProject(slug) : undefined;
			if (!existing) throw new UsageError(`Unknown project: ${slug ?? ""}`);
			const assignments = parseAssignments(rest);
			const next: { slug: string; title: string; status?: "active" | "parked" | "archived"; jiraEpic?: string | null; notesPath?: string | null } = { slug: existing.slug, title: assignments.title?.trim() || existing.title };
			for (const [key, value] of Object.entries(assignments)) {
				if (key === "title") continue;
				if (key === "status") {
					if (!["active", "parked", "archived"].includes(value)) throw new UsageError("status must be active, parked, or archived");
					next.status = value as "active" | "parked" | "archived";
				} else if (key === "epic") next.jiraEpic = value.trim() || null;
				else if (key === "notes_path") next.notesPath = value.trim() || null;
				else throw new UsageError(`Unknown project field: ${key}`);
			}
			rt.store.upsertProject(next, "user");
			deps.io.out(`Project ${slug} updated`);
			return 0;
		}
		throw new UsageError("Usage: work project [add <slug> <title> | set <slug> key=value...]");
	},
};

const sync: CliCommand = {
	usage: "sync [--force]                       Sync Jira and GitHub into triage",
	async run(args, deps) {
		const rt = deps.runtime();
		for (const warning of rt.warnings) deps.io.err(warning);
		const report = await syncAll(rt.store, rt.config, { jira: rt.jira, gh: rt.gh, backupDir: rt.backupDir }, { force: args.includes("--force") });
		deps.io.out(formatSyncReport(report));
		return 0;
	},
};

const exportCommand: CliCommand = {
	usage: "export [path]                        Write a JSON Lines backup",
	async run(args, deps) {
		const rt = deps.runtime();
		const path = args[0] ?? writeRotatingBackup(rt.store, rt.backupDir, rt.store.clock());
		if (args[0]) exportJsonl(rt.store, path);
		deps.io.out(`Exported to ${path}`);
		return 0;
	},
};

const importCommand: CliCommand = {
	usage: "import <path>                        Restore a backup into an empty database",
	async run(args, deps) {
		if (!args[0]) throw new UsageError("Usage: work import <path>");
		const rt = deps.runtime();
		const rows = importJsonl(rt.store, args[0]);
		deps.io.out(`Imported ${rows} rows from ${args[0]}`);
		return 0;
	},
};

const triageCommand: CliCommand = {
	usage: "triage                               Review the triage inbox",
	async run(_args, deps) {
		return runCliTriage(deps.runtime(), deps.io);
	},
};

const promote: CliCommand = {
	usage: "promote <W-n> [--yes]                Create a Jira ticket for an item",
	async run(args, deps) {
		const id = args.find((arg) => arg !== "--yes");
		if (!id) throw new UsageError("Usage: work promote <W-n> [--yes]");
		await cliPromote(deps.runtime(), deps.io, id, args.includes("--yes"));
		return 0;
	},
};

const undismiss: CliCommand = {
	usage: "undismiss <key>                      Let a dismissed key return to triage",
	async run(args, deps) {
		if (!args[0]) throw new UsageError("Usage: work undismiss <key>");
		const removed = deps.runtime().store.removeDismissal(args[0], "user");
		deps.io.out(removed ? `Removed dismissal for ${args[0]}` : `No dismissal for ${args[0]}`);
		return 0;
	},
};

const recap: CliCommand = {
	usage: "recap [today|yesterday|week]         Markdown recap for your daily note",
	async run(args, deps) {
		const which = (args[0] ?? "today") as "today" | "yesterday" | "week";
		if (!["today", "yesterday", "week"].includes(which)) throw new UsageError("Usage: work recap [today|yesterday|week]");
		const rt = deps.runtime();
		const now = rt.store.clock();
		deps.io.out(renderRecap(rt.store, recapRange(which, now), now));
		return 0;
	},
};

const restoreCommand: CliCommand = {
	usage: "restore [--auto | --dry-run]         Reopen crashed Pi sessions in tmux",
	async run(args, deps) {
		const mode: RestoreMode = args.includes("--dry-run") ? "dry-run" : args.includes("--auto") ? "auto" : "manual";
		const rt = deps.runtime();
		const report = runRestore(mode, { store: rt.store, tmux: deps.tmux ?? tmuxRunner(), readers: deps.readers, bootId: deps.bootId });
		deps.io.out(formatRestoreReport(report));
		return 0;
	},
};

const dash: CliCommand = {
	usage: "dash                                 Sessions and jobs dashboard (full screen; tmux popup via /dash)",
	async run(_args, deps) {
		const result = await runDash({
			runtime: deps.runtime(),
			terminal: deps.terminal ?? processTerminal(),
			tmux: deps.tmux ?? tmuxRunner(),
			insideTmux: Boolean(deps.env.TMUX),
			readers: deps.readers,
			bootId: deps.bootId,
		});
		if (result.print) deps.io.out(result.print);
		return 0;
	},
};

const JOB_USAGE = "Usage: work job add --name <name> --kind cron|process [--cwd <dir>] [--schedule <cron>] [--pid <n>] [--check <cmd>] [--stop <cmd>] [--log <path>] [--item W-n]";

const job: CliCommand = {
	usage: "job [add --name <n> --kind <k> ... | check [J-n]]   List, register, or check background jobs",
	async run(args, deps) {
		const rt = deps.runtime();
		const [action, ...rest] = args;
		if (!action) {
			const jobs = rt.store.listJobs();
			deps.io.out(jobs.length ? jobs.map((j) => formatJob(j, rt.store.clock())).join("\n") : "No jobs");
			return 0;
		}
		if (action === "add") {
			const flags = parseFlags(rest, ["name", "kind", "cwd", "schedule", "pid", "check", "stop", "log", "item"]);
			if (!flags.name || !flags.kind) throw new UsageError(JOB_USAGE);
			const { job: registered, created } = rt.store.registerJob({
				name: flags.name,
				kind: flags.kind as JobKind,
				cwd: flags.cwd ?? deps.cwd,
				schedule: flags.schedule,
				pid: flags.pid === undefined ? undefined : Number(flags.pid),
				checkCommand: flags.check,
				stopCommand: flags.stop,
				logPath: flags.log,
				itemId: flags.item,
			}, "user");
			deps.io.out(`${created ? "Added" : "Updated"} ${registered.id} ${registered.name}`);
			return 0;
		}
		if (action === "check") {
			const targets: Job[] = [];
			if (rest[0]) {
				const one = rt.store.getJob(rest[0]);
				if (!one) throw new UsageError(`Unknown job: ${rest[0]}`);
				targets.push(one);
			} else {
				targets.push(...rt.store.listJobs({ activeOnly: true }));
			}
			const checked = await checkJobs(rt.store, targets);
			deps.io.out(checked.length ? checked.map((j) => formatJob(j, rt.store.clock())).join("\n") : "No jobs to check");
			return 0;
		}
		throw new UsageError(JOB_USAGE);
	},
};

const today: CliCommand = {
	usage: "today                                Sync, triage, and open today's planner",
	async run(_args, deps) {
		const rt = deps.runtime();
		for (const warning of rt.warnings) deps.io.err(warning);
		const report = await syncAll(rt.store, rt.config, { jira: rt.jira, gh: rt.gh, backupDir: rt.backupDir });
		deps.io.out(formatSyncReport(report));
		if (openCandidates(rt.store).length > 0) await runCliTriage(rt, deps.io);
		const result = launchPlanner({ store: rt.store, cwd: expandHome(rt.config.plannerCwd ?? "~"), env: deps.env, tmux: deps.tmux ?? defaultTmux, now: rt.store.clock() });
		deps.io.out(result.message);
		return 0;
	},
};

export const COMMANDS: Record<string, CliCommand> = {
	add, list, show, set, project, sync, triage: triageCommand, today, promote, undismiss, recap, restore: restoreCommand, dash, job, export: exportCommand, import: importCommand,
};

export function usage(): string {
	return ["Usage: work <command>", ...Object.values(COMMANDS).map((command) => `  ${command.usage}`)].join("\n");
}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
	const [name, ...args] = argv;
	if (!name || name === "help" || name === "--help" || name === "-h") {
		deps.io.out(usage());
		return name ? 0 : 1;
	}
	const command = COMMANDS[name];
	if (!command) {
		deps.io.err(`Unknown command: ${name}`);
		deps.io.out(usage());
		return 1;
	}
	try {
		return await command.run(args, deps);
	} catch (error) {
		deps.io.err(error instanceof Error ? error.message : String(error));
		return 1;
	}
}
