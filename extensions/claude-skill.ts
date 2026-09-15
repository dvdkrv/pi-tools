import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { execFileSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fuzzySelect } from "../src/worktree/fuzzy-select.ts";

export type ClaudeSkill = { name: string; description: string; path: string };

export function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
	if (!match) return {};

	const result: { name?: string; description?: string } = {};
	for (const rawLine of match[1].split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const colon = line.indexOf(":");
		if (colon === -1) continue;
		const key = line.slice(0, colon).trim();
		let value = line.slice(colon + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		if (key === "name") result.name = value;
		if (key === "description") result.description = value;
	}
	return result;
}

export async function discoverClaudeSkills(roots: string[]): Promise<ClaudeSkill[]> {
	const skills: ClaudeSkill[] = [];
	const seen = new Set<string>();

	for (const root of roots) {
		if (!existsSync(root)) continue;
		let entries;
		try {
			entries = await readdir(root, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const skillPath = join(root, entry.name, "SKILL.md");
			if (!existsSync(skillPath)) continue;
			try {
				const frontmatter = parseSkillFrontmatter(await readFile(skillPath, "utf8"));
				const name = frontmatter.name || entry.name;
				if (seen.has(name)) continue;
				seen.add(name);
				skills.push({ name, description: frontmatter.description || "", path: skillPath });
			} catch {
				continue;
			}
		}
	}

	return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export function parseClaudeSkillArgs(args: string): { skillName?: string; prompt: string } {
	const pieces = args.trim().split(/\s+/).filter(Boolean);
	const skillName = pieces.shift();
	return { skillName, prompt: pieces.join(" ") };
}

export function buildClaudePrompt(skillName: string, prompt: string): string {
	const trimmed = prompt.trim();
	return trimmed ? `/skill:${skillName} ${trimmed}` : `/skill:${skillName}`;
}

function slugify(input: string): string {
	return input
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-") || "skill";
}

function shellQuote(value: string): string {
	if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function tmuxLaunchCommand(info: { cwd: string; skillName: string; prompt: string; insideTmux?: boolean }): {
	command: "tmux";
	args: string[];
	description: string;
} {
	const claudePrompt = buildClaudePrompt(info.skillName, info.prompt);
	const command = `claude ${shellQuote(claudePrompt)}`;
	const name = slugify(info.skillName);

	if (info.insideTmux) {
		return {
			command: "tmux",
			args: ["split-window", "-h", "-c", info.cwd, command],
			description: `Started Claude skill ${info.skillName} in a tmux pane`,
		};
	}

	const session = `claude-${name}`;
	return {
		command: "tmux",
		args: ["new-session", "-d", "-s", session, "-c", info.cwd, command],
		description: `Started tmux session ${session}. Attach with: tmux attach -t ${session}`,
	};
}

function defaultSkillRoots(cwd: string): string[] {
	const home = process.env.HOME || "";
	return [
		join(cwd, ".claude", "skills"),
		join(cwd, ".agents", "skills"),
		home ? join(home, ".claude", "skills") : "",
		home ? join(home, ".agents", "skills") : "",
	].filter(Boolean);
}

function commandExists(command: string): boolean {
	try {
		execFileSync("sh", ["-lc", `command -v ${shellQuote(command)}`], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

export default function claudeBridge(pi: ExtensionAPI): void {
	pi.registerCommand("claude-skill", {
		description: "Pick a Claude Code skill and launch Claude with it in tmux",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/claude-skill is available only in interactive TUI mode", "error");
				return;
			}
			if (!commandExists("claude")) {
				ctx.ui.notify("Claude CLI not found in PATH", "error");
				return;
			}
			if (!commandExists("tmux")) {
				ctx.ui.notify("tmux not found in PATH", "error");
				return;
			}

			const parsed = parseClaudeSkillArgs(args || "");
			let skillName = parsed.skillName;
			let prompt = parsed.prompt;

			if (!skillName) {
				const skills = await discoverClaudeSkills(defaultSkillRoots(ctx.cwd));
				if (skills.length === 0) {
					ctx.ui.notify("No Claude skills found in .claude/skills, .agents/skills, ~/.claude/skills, or ~/.agents/skills", "warning");
					return;
				}

				const skill = await fuzzySelect(ctx, {
					title: "Pick Claude skill",
					items: skills,
					limit: 10,
					placeholder: "type to fuzzy-search skills",
					getLabel: (item) => item.name,
					getDescription: (item) => item.description,
					getSearchText: (item) => `${item.name}\n${item.description}`,
				});
				if (!skill) return;
				skillName = skill.name;
				prompt = (await ctx.ui.input(`Arguments/prompt for ${skillName}`, "")) || "";
			}

			const launch = tmuxLaunchCommand({ cwd: ctx.cwd, skillName, prompt, insideTmux: Boolean(process.env.TMUX) });
			try {
				execFileSync(launch.command, launch.args, { encoding: "utf8" });
				ctx.ui.notify(launch.description, "info");
			} catch (error) {
				const text = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Failed to launch Claude skill: ${text}`, "error");
			}
		},
	});
}
