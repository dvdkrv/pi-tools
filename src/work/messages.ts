import type { MessageLogEntry } from "./types.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export function parseSince(value: string): number {
	const match = /^(\d+)([mhd])?$/.exec(value);
	const amount = match ? Number(match[1]) : 0;
	if (!match || amount < 1) throw new Error("--since must be an age like 30m, 2h, or 7d");
	const unit = match[2] ?? "h";
	return amount * (unit === "m" ? MINUTE_MS : unit === "h" ? HOUR_MS : DAY_MS);
}

export function messageStateLabel(state: string): string {
	switch (state) {
		case "queued": return "queued";
		case "attempted": return "delivering";
		case "observed": return "delivered";
		case "terminal-unresolved": return "unconfirmed";
		default: return state;
	}
}

function escaped(value: string): string {
	return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

export function formatMessageLog(entries: readonly MessageLogEntry[], now: Date): string {
	void now;
	return [...entries]
		.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
		.map((entry) => {
			const at = new Date(entry.at).toISOString().slice(0, 16).replace("T", " ");
			const reply = entry.inReplyTo ? `  re ${escaped(entry.inReplyTo.slice(0, 8))}` : "";
			const header = `${at}  ${escaped(entry.senderName)} -> ${escaped(entry.recipientName)}  ${entry.kind}  ${escaped(messageStateLabel(entry.state))}${reply}`;
			return [header, ...escaped(entry.body).split("\n").map((line) => `    ${line}`)].join("\n");
		})
		.join("\n\n");
}
