import { writeRotatingBackup } from "./backup.ts";
import type { WorkConfig } from "./config.ts";
import type { GhRunner } from "./connectors/github.ts";
import { fetchGithub } from "./connectors/github.ts";
import type { JiraClient } from "./connectors/jira.ts";
import { fetchJira } from "./connectors/jira.ts";
import type { ReconcileSummary } from "./reconcile.ts";
import { emptySummary, reconcile } from "./reconcile.ts";
import type { WorkStore } from "./store.ts";
import type { ConnectorResult, LinkKind } from "./types.ts";

export const SYNC_TTL_MS = 10 * 60 * 1000;
export const BACKUP_INTERVAL_MS = 60 * 60 * 1000;

export type SyncDeps = { jira?: JiraClient; gh?: GhRunner; backupDir?: string };
export type SyncReport = { ran: string[]; cached: string[]; disabled: string[]; totals: ReconcileSummary; warnings: string[]; backup?: string };

function linkedKeys(store: WorkStore, kind: LinkKind): string[] {
	const active = new Set(store.listItems({ statuses: ["todo", "doing", "waiting", "parked"] }).map((item) => item.id));
	return store.listAllLinks().filter((link) => link.kind === kind && active.has(link.itemId)).map((link) => link.key);
}

export function connectorWarnings(store: WorkStore): string[] {
	return store.listConnectorRuns()
		.filter((run) => run.status !== "ok")
		.map((run) => `⚠️ ${run.connector} ${run.query}: ${run.status}; data as of ${run.lastOkAt ?? "never"}`);
}

export async function syncAll(store: WorkStore, config: WorkConfig, deps: SyncDeps, options: { force?: boolean } = {}): Promise<SyncReport> {
	const now = store.clock();
	const report: SyncReport = { ran: [], cached: [], disabled: [], totals: emptySummary(), warnings: [] };
	if (deps.backupDir) {
		const last = store.getMeta("backup:last");
		if (!last || now.getTime() - Date.parse(last) >= BACKUP_INTERVAL_MS) {
			report.backup = writeRotatingBackup(store, deps.backupDir, now);
			store.setMeta("backup:last", now.toISOString());
		}
	}
	const connectors: { name: string; enabled: boolean; run: () => Promise<ConnectorResult[]> }[] = [
		{
			name: "jira",
			enabled: Boolean(config.jira && deps.jira),
			run: () => fetchJira(deps.jira as JiraClient, linkedKeys(store, "jira").map((key) => key.slice("jira:".length)), now),
		},
		{
			name: "github",
			enabled: config.github.accounts.length > 0 && Boolean(deps.gh),
			run: () => fetchGithub(config.github.accounts, deps.gh as GhRunner, linkedKeys(store, "github-pr"), now),
		},
	];
	for (const connector of connectors) {
		if (!connector.enabled) {
			report.disabled.push(connector.name);
			continue;
		}
		const last = store.getMeta(`sync:last:${connector.name}`);
		if (!options.force && last && now.getTime() - Date.parse(last) < SYNC_TTL_MS) {
			report.cached.push(connector.name);
			continue;
		}
		const results = await connector.run();
		for (const result of results) {
			store.recordConnectorRun({ connector: result.connector, query: result.query, status: result.status, error: result.error ?? null });
			if (result.status !== "ok") continue;
			const summary = reconcile(store, result, config);
			report.totals.updatedLinks += summary.updatedLinks;
			report.totals.signals += summary.signals;
			report.totals.created += summary.created;
			report.totals.withdrawn += summary.withdrawn;
		}
		if (results.every((result) => result.status === "ok")) store.setMeta(`sync:last:${connector.name}`, now.toISOString());
		report.ran.push(connector.name);
	}
	report.warnings = connectorWarnings(store);
	return report;
}

export function formatSyncReport(report: SyncReport): string {
	const lines = [
		`synced: ${report.ran.join(", ") || "-"}; cached: ${report.cached.join(", ") || "-"}; disabled: ${report.disabled.join(", ") || "-"}`,
		`new candidates: ${report.totals.created}; signals: ${report.totals.signals}; withdrawn: ${report.totals.withdrawn}`,
		...report.warnings,
	];
	return lines.join("\n");
}
