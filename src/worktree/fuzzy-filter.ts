export type FuzzyFilterOptions<T> = {
	getSearchText: (item: T) => string;
	limit?: number;
};

function fuzzyScore(text: string, query: string): number | undefined {
	const normalizedText = text.toLowerCase();
	const normalizedQuery = query.toLowerCase().trim();
	if (!normalizedQuery) return 0;

	let lastIndex = -1;
	let firstIndex = -1;
	let score = 0;
	for (const char of normalizedQuery) {
		const index = normalizedText.indexOf(char, lastIndex + 1);
		if (index === -1) return undefined;
		if (firstIndex === -1) firstIndex = index;
		const gap = index - lastIndex - 1;
		score += gap;
		lastIndex = index;
	}

	return score + firstIndex * 0.1 + normalizedText.length * 0.001;
}

export function fuzzyFilter<T>(items: T[], query: string, options: FuzzyFilterOptions<T>): T[] {
	const limit = options.limit ?? 10;
	const normalizedQuery = query.trim();
	if (!normalizedQuery) return items.slice(0, limit);

	return items
		.map((item, index) => ({ item, index, score: fuzzyScore(options.getSearchText(item), normalizedQuery) }))
		.filter((entry): entry is { item: T; index: number; score: number } => entry.score !== undefined)
		.sort((a, b) => a.score - b.score || a.index - b.index)
		.slice(0, limit)
		.map((entry) => entry.item);
}
