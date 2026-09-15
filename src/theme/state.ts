import { readFileSync, unwatchFile, watchFile } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Appearance = "light" | "dark";

type WatchListener = () => void;

export interface WatchDependencies {
	read(path: string): string | undefined;
	watch(path: string, listener: WatchListener): void;
	unwatch(path: string, listener: WatchListener): void;
}

export function parseAppearance(value: unknown): Appearance | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	return normalized === "light" || normalized === "dark" ? normalized : undefined;
}

export function resolveThemeStatePath(env: NodeJS.ProcessEnv = process.env): string {
	const stateHome = env.XDG_STATE_HOME?.trim();
	if (stateHome) return join(stateHome, "theme");
	const home = env.HOME?.trim() || homedir();
	return join(home, ".local", "state", "theme");
}

export function readAppearance(path: string): Appearance | undefined {
	try {
		return parseAppearance(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

export function resolveInitialAppearance(
	path: string,
	env: NodeJS.ProcessEnv = process.env,
	read: (path: string) => unknown = readAppearance,
): Appearance {
	return parseAppearance(read(path)) ?? parseAppearance(env.LC_TERMINAL_THEME) ?? "dark";
}

const defaultWatchDependencies: WatchDependencies = {
	read: path => {
		try {
			return readFileSync(path, "utf8");
		} catch {
			return undefined;
		}
	},
	watch: (path, listener) => watchFile(path, { interval: 200, persistent: false }, listener),
	unwatch: (path, listener) => unwatchFile(path, listener),
};

export function watchAppearance(
	path: string,
	current: Appearance,
	onAppearance: (appearance: Appearance) => void,
	dependencies: WatchDependencies = defaultWatchDependencies,
): () => void {
	let lastAppearance = current;
	let closed = false;
	const listener = () => {
		const nextAppearance = parseAppearance(dependencies.read(path));
		if (!nextAppearance || nextAppearance === lastAppearance) return;
		lastAppearance = nextAppearance;
		onAppearance(nextAppearance);
	};
	dependencies.watch(path, listener);
	listener();
	return () => {
		if (closed) return;
		closed = true;
		dependencies.unwatch(path, listener);
	};
}
