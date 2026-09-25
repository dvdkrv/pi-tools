import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCHEMA_VERSION } from "./migrations.ts";
import type { WorkStore } from "./store.ts";

export const BACKUP_KEEP = 14;

export function exportJsonl(store: WorkStore, path: string): number {
	const lines = [JSON.stringify({ format: "work-backup", schema: SCHEMA_VERSION })];
	let rows = 0;
	for (const [table, list] of Object.entries(store.dumpTables())) {
		for (const row of list) {
			lines.push(JSON.stringify({ table, row }));
			rows++;
		}
	}
	writeFileSync(path, `${lines.join("\n")}\n`, { mode: 0o600 });
	return rows;
}

export function importJsonl(store: WorkStore, path: string): number {
	if (!store.isEmpty()) throw new Error("Refusing to import into a non-empty work database");
	const [header, ...rest] = readFileSync(path, "utf8").split("\n").filter((line) => line.trim());
	const meta = JSON.parse(header ?? "{}") as { format?: string; schema?: number };
	if (meta.format !== "work-backup") throw new Error(`${path} is not a work backup`);
	if (Number(meta.schema) > SCHEMA_VERSION) throw new Error(`Backup schema ${meta.schema} is newer than supported ${SCHEMA_VERSION}`);
	const rows = rest.map((line) => JSON.parse(line) as { table: string; row: Record<string, unknown> });
	store.loadTables(rows);
	return rows.length;
}

export function writeRotatingBackup(store: WorkStore, dir: string, now: Date, keep: number = BACKUP_KEEP): string {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const path = join(dir, `work-${now.toISOString().replace(/[:.]/g, "-")}.jsonl`);
	exportJsonl(store, path);
	const files = readdirSync(dir).filter((file) => /^work-.*\.jsonl$/.test(file)).sort();
	for (const file of files.slice(0, Math.max(0, files.length - keep))) rmSync(join(dir, file));
	return path;
}
