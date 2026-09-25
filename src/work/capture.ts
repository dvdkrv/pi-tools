import type { Rule } from "./config.ts";
import { projectFor } from "./rules.ts";
import type { WorkStore } from "./store.ts";
import type { Actor, Item, LinkKind } from "./types.ts";

export class CaptureError extends Error {}

export type CapturedLink = { kind: LinkKind; key: string; url: string };
export type ParsedCapture = { title: string; project?: string; due?: string; links: CapturedLink[] };
export type CaptureContext = { repo?: string; now: Date; knownProjects: ReadonlySet<string>; rules: Rule[] };

const DAY_NAMES: Record<string, number> = {
	sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3,
	thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};
const URL_TOKEN = /^(?:https?|obsidian):\/\//i;
const PROJECT_TOKEN = /^#[a-z][a-z0-9-]*$/i;

export function localDate(date: Date): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function resolveDue(value: string, now: Date): string {
	const v = value.trim().toLowerCase();
	if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
		const [year, month, day] = v.split("-").map(Number);
		const date = new Date(year, month - 1, day);
		if (localDate(date) !== v) throw new CaptureError(`Invalid due date: ${value}`);
		return v;
	}
	const date = new Date(now);
	if (v === "today") return localDate(date);
	if (v === "tomorrow") {
		date.setDate(date.getDate() + 1);
		return localDate(date);
	}
	const weekday = DAY_NAMES[v];
	if (weekday === undefined) throw new CaptureError(`Invalid due date: ${value} (use YYYY-MM-DD, today, tomorrow, or a weekday)`);
	date.setDate(date.getDate() + ((weekday - date.getDay() + 7) % 7));
	return localDate(date);
}

export function linkFromUrl(raw: string): CapturedLink {
	const url = raw.replace(/[),.;]+$/, "");
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return { kind: "url", key: `url:${url}`, url };
	}
	if (parsed.protocol === "obsidian:") return { kind: "note", key: `note:${url}`, url };
	const host = parsed.hostname.toLowerCase();
	const path = parsed.pathname.replace(/\/+$/, "");
	if (host === "github.com") {
		const match = /^\/([^/]+)\/([^/]+)\/(pull|issues)\/(\d+)/.exec(path);
		if (match) {
			const repo = `${match[1]}/${match[2]}`;
			const kind = match[3] === "pull" ? "github-pr" : "github-issue";
			const segment = match[3] === "pull" ? "pr" : "issue";
			return { kind, key: `github:${segment}:${repo.toLowerCase()}#${match[4]}`, url: `https://github.com/${repo}/${match[3]}/${match[4]}` };
		}
	}
	const jira = /^\/browse\/([A-Z][A-Z0-9]+-\d+)$/.exec(path);
	if (jira && host.endsWith(".atlassian.net")) return { kind: "jira", key: `jira:${jira[1]}`, url: `${parsed.origin}/browse/${jira[1]}` };
	if (host === "slack.com" || host.endsWith(".slack.com")) return { kind: "chat", key: `chat:${parsed.origin}${path}`, url };
	return { kind: "url", key: `url:${url}`, url };
}

export function parseCapture(text: string, now: Date): ParsedCapture {
	let project: string | undefined;
	let due: string | undefined;
	const links: CapturedLink[] = [];
	const words: string[] = [];
	for (const token of text.trim().split(/\s+/).filter(Boolean)) {
		if (PROJECT_TOKEN.test(token)) {
			if (project) throw new CaptureError("Only one #project is allowed");
			project = token.slice(1).toLowerCase();
			continue;
		}
		if (/^due:/i.test(token)) {
			if (due) throw new CaptureError("Only one due: is allowed");
			due = resolveDue(token.slice(4), now);
			continue;
		}
		if (URL_TOKEN.test(token)) {
			const link = linkFromUrl(token);
			if (!links.some((existing) => existing.key === link.key)) links.push(link);
		}
		words.push(token);
	}
	const withoutUrls = words.filter((word) => !URL_TOKEN.test(word)).join(" ").trim();
	const title = withoutUrls || words.join(" ").trim();
	if (!title) throw new CaptureError("Nothing to capture");
	return { title, project, due, links };
}

function suggestion(slug: string, known: ReadonlySet<string>): string {
	const close = [...known].filter((candidate) => candidate.includes(slug) || slug.includes(candidate) || candidate.slice(0, 2) === slug.slice(0, 2));
	const list = (close.length ? close : [...known]).map((candidate) => `#${candidate}`).join(", ");
	return close.length ? `; did you mean ${list}?` : `; known projects: ${list}`;
}

export function captureItem(store: WorkStore, text: string, ctx: CaptureContext, actor: Actor): Item {
	const parsed = parseCapture(text, ctx.now);
	if (parsed.project && !ctx.knownProjects.has(parsed.project)) {
		throw new CaptureError(`Unknown project #${parsed.project}${suggestion(parsed.project, ctx.knownProjects)}`);
	}
	const project = parsed.project ?? projectFor({ repo: ctx.repo }, ctx.rules, ctx.knownProjects);
	return store.transaction(() => {
		for (const link of parsed.links) {
			const existing = store.findLinkByKey(link.key);
			if (existing) throw new CaptureError(`${link.url} is already linked to ${existing.itemId}`);
		}
		const item = store.addItem({ project, title: parsed.title, origin: "manual", due: parsed.due ?? null }, actor);
		for (const link of parsed.links) store.addLink(item.id, link, actor);
		return item;
	});
}
