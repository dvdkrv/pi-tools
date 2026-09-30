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

export function messageCost(usage: Usage, price: ModelPrice | undefined): MessageCost {
	if (usage.cost.total > 0) return usage.cost.total;
	const input = usage.input + usage.cacheRead + usage.cacheWrite;
	const output = usage.output;
	if (!(input > 0 || output > 0)) return 0;
	if (!price) return "unknown";
	// Cache tokens are deliberately charged at the full input price for a conservative cap.
	return (input * price.input + output * price.output) / 1_000_000;
}
