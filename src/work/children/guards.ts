// Pure command and path checks for child agents. They catch accidents, not a hostile model:
// a command hidden inside `sh -c "…"` is not inspected.

export const EXPENSIVE_MESSAGE = "Blocked: repository-wide test run. Run only the tests covering the files you changed. Full-suite verification runs in CI on the draft PR.";

export const BUILT_IN_IGNORE: readonly string[] = [
	"package-lock.json",
	"pnpm-lock.yaml",
	"yarn.lock",
	"uv.lock",
	"poetry.lock",
	"Cargo.lock",
	"go.sum",
	"**/__snapshots__/**",
	"**/vendor/**",
	"**/generated/**",
];

// Each pattern matches one normalized segment (single spaces, no redirections, no leading assignments).
const BUILT_IN_EXPENSIVE: readonly RegExp[] = [
	/^(?:npm|pnpm|yarn)(?: run)? test$/,
	/^(?:(?:uv|poetry) run |python3? -m )?pytest(?: -\S+)*$/,
	/^go test(?: \S+)* \.\/\.\.\.(?: \S+)*$/,
	/^cargo test(?: -(?!p$|p |-package\b)\S*)*$/,
	/^bazel test(?: \S+)* \/\/\.\.\.(?: \S+)*$/,
	/^make test$/,
	/^tox(?: (?!-e)\S+)*$/,
	/^ddev test(?: -\S+)*$/,
];

const GIT = String.raw`git(?: -[Cc] \S+)* `;
const HISTORY = "Blocked: rewriting history. Make a new commit instead.";
const BRANCHES = "Blocked: switching branches. Stay on your branch; restore files with git restore or git checkout -- <paths>.";
const DEPENDENCY = "Blocked: adding a dependency. Needing a dependency is a question for the lead: end with session_status needs-me, naming the package and why.";

const RESTRICTED: readonly { pattern: RegExp; message: string }[] = [
	{ pattern: new RegExp(`^${GIT}push\\b`), message: "Blocked: git push. The lead merges and pushes your branch; commit and end with session_status." },
	{ pattern: new RegExp(`^${GIT}remote (?:add|set-url|remove|rm|rename|set-head|set-branches|prune|update)\\b`), message: "Blocked: changing git remotes." },
	{ pattern: /^gh pr\b/, message: "Blocked: gh pr. The lead owns the pull request." },
	{ pattern: /^gh api\b(?=.*(?: (?:-X|--method)(?: |=)(?!GET\b)[A-Za-z]+| (?:-f|-F|--field|--raw-field|--input)(?: |=)))/, message: "Blocked: gh api writes." },
	{ pattern: new RegExp(`^${GIT}reset\\b.* --hard\\b`), message: HISTORY },
	{ pattern: new RegExp(`^${GIT}rebase\\b`), message: HISTORY },
	{ pattern: new RegExp(`^${GIT}commit\\b.* --amend\\b`), message: HISTORY },
	{ pattern: new RegExp(`^${GIT}switch\\b`), message: BRANCHES },
	{ pattern: new RegExp(`^${GIT}checkout\\b(?!.* --(?: |$))`), message: BRANCHES },
	{ pattern: /^(?:npm|pnpm|yarn) (?:install|i|add)(?: -\S+)* [^\s-]/, message: DEPENDENCY },
	{ pattern: /^(?:pip3?|python3? -m pip) install\b/, message: DEPENDENCY },
	{ pattern: /^uv (?:add|pip install)\b/, message: DEPENDENCY },
	{ pattern: /^(?:poetry add|go get|cargo add)\b/, message: DEPENDENCY },
];

const OVER_BUDGET_COMMANDS = /^git (?:status|diff|log|add|commit)(?: |$)/;

export function commandSegments(command: string): string[] {
	return command
		.replace(/\d*>&\d*/g, " ")
		.replace(/\d*>>?\s*\S+/g, " ")
		.replace(/<\s*\S+/g, " ")
		.split(/&&|\|\||[;|&\n()]/)
		.map((part) => part.trim().replace(/\s+/g, " ").replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S* )+/, ""))
		.filter(Boolean);
}

function compile(patterns: readonly string[]): RegExp[] {
	return patterns.flatMap((pattern) => {
		try {
			return [new RegExp(pattern)];
		} catch {
			return [];
		}
	});
}

export function expensiveVerdict(command: string, extra: readonly string[] = []): string | undefined {
	const patterns = [...BUILT_IN_EXPENSIVE, ...compile(extra)];
	return commandSegments(command).some((segment) => patterns.some((pattern) => pattern.test(segment))) ? EXPENSIVE_MESSAGE : undefined;
}

export function restrictedVerdict(command: string): string | undefined {
	for (const segment of commandSegments(command)) {
		const rule = RESTRICTED.find((candidate) => candidate.pattern.test(segment));
		if (rule) return rule.message;
	}
	return undefined;
}

// Over budget, a child may still commit: git status, diff, log, add, and commit (alone or chained with && and ;),
// and the brief's acceptance commands exactly. Quoted text is ignored, unless double quotes hold $ or backticks.
export function overBudgetAllowed(command: string, acceptance: readonly string[]): boolean {
	const trimmed = command.trim();
	if (acceptance.some((allowed) => allowed.trim() === trimmed)) return true;
	const unquoted = trimmed.replace(/'[^']*'/g, "''").replace(/"[^"$`\\]*"/g, '""');
	if (/[|<>$`()]|(?<!&)&(?!&)/.test(unquoted)) return false;
	return unquoted.split(/&&|;|\n/).every((part) => OVER_BUDGET_COMMANDS.test(part.trim().replace(/\s+/g, " ")));
}

export function globRegExp(pattern: string): RegExp {
	let source = "";
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i];
		if (char === "*" && pattern[i + 1] === "*") {
			const slash = pattern[i + 2] === "/";
			source += slash ? "(?:.*/)?" : ".*";
			i += slash ? 2 : 1;
		} else if (char === "*") {
			source += "[^/]*";
		} else if (char === "?") {
			source += "[^/]";
		} else {
			source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		}
	}
	return new RegExp(`^${source}$`);
}

export function inScope(path: string, scope: readonly string[]): boolean {
	return scope.some((raw) => {
		const pattern = raw.replace(/^\.\//, "").replace(/\/$/, "");
		if (/[*?]/.test(pattern)) return globRegExp(pattern).test(path);
		return path === pattern || path.startsWith(`${pattern}/`);
	});
}

export function isIgnored(path: string, patterns: readonly string[]): boolean {
	const base = path.slice(path.lastIndexOf("/") + 1);
	return patterns.some((pattern) => globRegExp(pattern).test(pattern.includes("/") ? path : base));
}
