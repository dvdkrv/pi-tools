import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type Appearance,
	resolveInitialAppearance,
	resolveThemeStatePath,
	watchAppearance,
} from "../src/theme/state.ts";

export interface ThemeSyncDependencies {
	resolveStatePath(): string;
	resolveInitial(path: string): Appearance;
	watch(
		path: string,
		current: Appearance,
		onAppearance: (appearance: Appearance) => void,
	): () => void;
	schedule(callback: () => void): () => void;
}

const defaultDependencies: ThemeSyncDependencies = {
	resolveStatePath: () => resolveThemeStatePath(),
	resolveInitial: path => resolveInitialAppearance(path),
	watch: (path, current, onAppearance) => watchAppearance(path, current, onAppearance),
	schedule: callback => {
		const handle = setImmediate(callback);
		return () => clearImmediate(handle);
	},
};

export function registerThemeSync(
	pi: ExtensionAPI,
	dependencies: ThemeSyncDependencies = defaultDependencies,
): void {
	let stopWatching: (() => void) | undefined;
	let cancelScheduledStart: (() => void) | undefined;
	let appliedAppearance: Appearance | undefined;
	let warned = false;

	const stop = () => {
		cancelScheduledStart?.();
		cancelScheduledStart = undefined;
		stopWatching?.();
		stopWatching = undefined;
	};

	pi.on("session_start", (_event, ctx) => {
		stop();
		appliedAppearance = undefined;
		warned = false;
		if (ctx.mode !== "tui") return;

		const apply = (appearance: Appearance) => {
			if (appearance === appliedAppearance) return;
			const selectedTheme = ctx.ui.getTheme(appearance);
			if (!selectedTheme) {
				if (!warned) {
					warned = true;
					ctx.ui.notify(`Unable to load Pi theme "${appearance}".`, "warning");
				}
				return;
			}
			const result = ctx.ui.setTheme(selectedTheme);
			if (!result.success) {
				if (!warned) {
					warned = true;
					ctx.ui.notify(`Unable to apply Pi theme "${appearance}": ${result.error}`, "warning");
				}
				return;
			}
			appliedAppearance = appearance;
		};

		cancelScheduledStart = dependencies.schedule(() => {
			cancelScheduledStart = undefined;
			const path = dependencies.resolveStatePath();
			const initialAppearance = dependencies.resolveInitial(path);
			apply(initialAppearance);
			stopWatching = dependencies.watch(path, initialAppearance, apply);
		});
	});

	pi.on("session_shutdown", stop);
}

export default function themeSyncExtension(pi: ExtensionAPI): void {
	registerThemeSync(pi);
}
