import { readFileSync } from "node:fs";
import { NOTE_MAX } from "./types.ts";

export const TRANSCRIPT_LIMIT = 30;

export type TranscriptMessage = { role: "user" | "assistant"; text: string };

type Entry = { type?: unknown; id?: unknown; parentId?: unknown; message?: unknown };

function roleOf(message: unknown): string | undefined {
	if (!message || typeof message !== "object") return undefined;
	const role = (message as { role?: unknown }).role;
	return typeof role === "string" ? role : undefined;
}

export function messageText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const texts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const { type, text } = part as { type?: unknown; text?: unknown };
		if (type === "text" && typeof text === "string") texts.push(text);
	}
	return texts.join("\n");
}

export function lastAssistantLine(messages: readonly unknown[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (roleOf(messages[i]) !== "assistant") continue;
		const lines = messageText(messages[i]).split("\n").map((line) => line.trim()).filter(Boolean);
		const last = lines.at(-1);
		if (last) return last.slice(0, NOTE_MAX);
	}
	return "";
}

// Follows parentId links back from the last entry, so abandoned branches are skipped.
export function parseTranscript(jsonl: string, limit: number = TRANSCRIPT_LIMIT): TranscriptMessage[] {
	const byId = new Map<string, Entry>();
	let leaf: Entry | undefined;
	for (const line of jsonl.split("\n")) {
		if (!line.trim()) continue;
		let entry: Entry;
		try {
			entry = JSON.parse(line) as Entry;
		} catch {
			continue;
		}
		if (typeof entry.id !== "string" || entry.type === "session") continue;
		byId.set(entry.id, entry);
		leaf = entry;
	}
	const path: Entry[] = [];
	const seen = new Set<string>();
	let current = leaf;
	while (current && !seen.has(String(current.id))) {
		seen.add(String(current.id));
		path.push(current);
		current = typeof current.parentId === "string" ? byId.get(current.parentId) : undefined;
	}
	const messages: TranscriptMessage[] = [];
	for (const entry of path.reverse()) {
		if (entry.type !== "message") continue;
		const role = roleOf(entry.message);
		const text = messageText(entry.message).trim();
		if ((role === "user" || role === "assistant") && text) messages.push({ role, text });
	}
	return messages.slice(-limit);
}

export function readTranscript(path: string, limit: number = TRANSCRIPT_LIMIT): TranscriptMessage[] {
	return parseTranscript(readFileSync(path, "utf8"), limit);
}

export function formatTranscript(messages: readonly TranscriptMessage[]): string {
	if (messages.length === 0) return "(no messages yet)";
	return messages.map((message) => `${message.role}:\n${message.text.split("\n").map((line) => `  ${line}`).join("\n")}`).join("\n\n");
}
