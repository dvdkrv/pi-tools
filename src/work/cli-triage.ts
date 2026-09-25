import type { CliIo } from "./cli.ts";
import { applyJiraUpdate, formatPreview, promoteItem, promotionPreview } from "./connectors/jira.ts";
import type { Runtime } from "./runtime.ts";
import { errorMessage } from "./secrets.ts";
import {
	acceptAllFromSource,
	acceptCandidate,
	candidateDetails,
	dismissCandidate,
	mergeCandidate,
	openCandidates,
	snoozeCandidate,
	TriageError,
} from "./triage.ts";
import type { Candidate } from "./types.ts";

const YES = /^y(?:es)?$/i;

export async function cliPromote(rt: Runtime, io: CliIo, itemId: string, yes: boolean): Promise<void> {
	if (!rt.jira) throw new TriageError("Jira is not configured");
	const preview = promotionPreview(rt.store, itemId, rt.jira.config);
	io.out(formatPreview(preview));
	if (!yes && !YES.test((await io.ask("Create this ticket? [y/N] > ")).trim())) {
		io.out("Cancelled");
		return;
	}
	const link = await promoteItem(rt.store, itemId, rt.jira);
	io.out(`Created ${link.key.slice("jira:".length)} for ${itemId}`);
}

async function cliApplyJiraUpdate(rt: Runtime, io: CliIo, candidate: Candidate): Promise<void> {
	if (!rt.jira) throw new TriageError("Jira is not configured");
	if (!YES.test((await io.ask(`Apply "${candidate.title}" in Jira? [y/N] > `)).trim())) {
		io.out("Cancelled");
		return;
	}
	const result = await applyJiraUpdate(rt.store, candidate.id, rt.jira, async (options) => {
		options.forEach((option, index) => io.out(`  ${index + 1}. ${option.name} (${option.category})`));
		const choice = Number((await io.ask("Transition number (empty cancels) > ")).trim());
		return Number.isInteger(choice) && choice >= 1 ? options[choice - 1] : undefined;
	});
	io.out(result === "applied" ? `Updated ${String(candidate.payload.ticket)}` : "Cancelled");
}

async function askEdits(rt: Runtime, io: CliIo, candidate: Candidate): Promise<{ title?: string; project?: string }> {
	const title = (await io.ask(`Title [${candidate.title}] > `)).trim();
	const proposed = candidate.proposedProject ?? "misc";
	const project = (await io.ask(`Project [#${proposed}] > `)).trim().replace(/^#/, "");
	if (project && !rt.knownProjects().has(project)) throw new TriageError(`Unknown project #${project}`);
	return { title: title || undefined, project: project || proposed };
}

export async function runCliTriage(rt: Runtime, io: CliIo): Promise<number> {
	const skipped = new Set<number>();
	for (;;) {
		const open = openCandidates(rt.store).filter((candidate) => !skipped.has(candidate.id));
		if (open.length === 0) {
			io.out(skipped.size ? `Triage done (${skipped.size} skipped)` : "Triage inbox is empty");
			return 0;
		}
		const candidate = open[0];
		const isJira = candidate.kind === "jira-update";
		io.out(candidateDetails(candidate, open.length));
		const answer = (await io.ask(isJira
			? "[a]pply [d]ismiss [z]snooze [s]kip [q]uit > "
			: "[a]ccept [m]erge [d]ismiss [z]snooze [A]ll from source [p]romote [s]kip [q]uit > ")).trim();
		try {
			switch (answer) {
				case "q":
					return 0;
				case "":
				case "s":
					skipped.add(candidate.id);
					break;
				case "d":
					dismissCandidate(rt.store, candidate.id);
					io.out("Dismissed");
					break;
				case "z": {
					const days = (await io.ask("Snooze days [3] > ")).trim();
					snoozeCandidate(rt.store, candidate.id, days ? Number(days) : 3);
					io.out("Snoozed");
					break;
				}
				case "m": {
					if (isJira) throw new TriageError("Jira updates can't be merged");
					const target = (await io.ask("Merge into item (W-n) > ")).trim();
					mergeCandidate(rt.store, candidate.id, target);
					io.out(`Merged into ${target}`);
					break;
				}
				case "A": {
					if (isJira) throw new TriageError("Jira updates can't be bulk accepted");
					io.out(`Accepted ${acceptAllFromSource(rt.store, candidate.source).length} from ${candidate.source}`);
					break;
				}
				case "a":
				case "p": {
					if (isJira) {
						if (answer === "p") throw new TriageError("Use a to apply a Jira update");
						await cliApplyJiraUpdate(rt, io, candidate);
						break;
					}
					const edits = candidate.kind === "new-item" ? await askEdits(rt, io, candidate) : {};
					const item = acceptCandidate(rt.store, candidate.id, edits);
					io.out(candidate.kind === "attach-link" ? `Linked to ${item.id}` : `${item.id} added to ${item.project}`);
					if (answer === "p") await cliPromote(rt, io, item.id, false);
					break;
				}
				default:
					io.err(`Unknown choice: ${answer}`);
			}
		} catch (error) {
			io.err(errorMessage(error));
			skipped.add(candidate.id);
		}
	}
}
