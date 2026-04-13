import type { DiffFileEntry } from "../types";

function normalize(value: string): string {
	return value.trim().toLowerCase();
}

export function scoreFileMatch(query: string, file: DiffFileEntry): number {
	const normalizedQuery = normalize(query);
	if (!normalizedQuery) {
		return 1;
	}
	const target = normalize(file.path);
	if (target.includes(normalizedQuery)) {
		return normalizedQuery.length / Math.max(target.length, 1) + 10;
	}
	let score = 0;
	let queryIndex = 0;
	for (const character of target) {
		if (character === normalizedQuery[queryIndex]) {
			score += 1;
			queryIndex += 1;
			if (queryIndex === normalizedQuery.length) {
				return score;
			}
		}
	}
	return 0;
}

export function filterFilesByQuery(files: DiffFileEntry[], query: string): DiffFileEntry[] {
	const normalizedQuery = normalize(query);
	if (!normalizedQuery) {
		return files;
	}
	return [...files]
		.map((file) => ({ file, score: scoreFileMatch(normalizedQuery, file) }))
		.filter((candidate) => candidate.score > 0)
		.sort((left, right) => right.score - left.score || left.file.path.localeCompare(right.file.path))
		.map((candidate) => candidate.file);
}
