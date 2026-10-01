import type { Usage } from "@earendil-works/pi-ai";
import type { ChildrenConfig } from "../config.ts";

export type ModelPrice = ChildrenConfig["pricing"][string];
export type MessageCost = number | "unknown";

function globPattern(glob: string): RegExp {
	const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
	return new RegExp(`^${escaped}$`);
}

export function priceFor(pricing: ChildrenConfig["pricing"], model: string): ModelPrice | undefined {
	const exact = pricing[model];
	if (exact) return exact;
	for (const [pattern, price] of Object.entries(pricing)) {
		if (pattern.includes("*") && globPattern(pattern).test(model)) return price;
	}
	return undefined;
}

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

// Usage comes from another process, so every field is checked rather than trusted to match pi-ai's Usage.
export function messageCost(usage: unknown, price: ModelPrice | undefined): MessageCost {
	const u = (typeof usage === "object" && usage !== null ? usage : {}) as Partial<Record<keyof Usage, unknown>>;
	const reported = count((u.cost as { total?: unknown } | undefined)?.total);
	if (reported > 0) return reported;
	const input = count(u.input);
	const cacheRead = count(u.cacheRead);
	const cacheWrite = count(u.cacheWrite);
	const output = count(u.output);
	if (input === 0 && cacheRead === 0 && cacheWrite === 0 && output === 0) return 0;
	if (!price) return "unknown";
	// Cache reads usually cost about a tenth of input; charging them at full price overestimated
	// cache-heavy child runs about fivefold and stopped them early. Long-context price tiers are ignored.
	const readRate = price.cacheRead ?? price.input * 0.1;
	const writeRate = price.cacheWrite ?? price.input * 1.25;
	return (input * price.input + cacheRead * readRate + cacheWrite * writeRate + output * price.output) / 1_000_000;
}
