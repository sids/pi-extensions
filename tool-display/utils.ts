import { homedir } from "node:os";
import { isAbsolute } from "node:path";

export type ToolResultContent = {
	type: string;
	text?: string;
};

export type ToolResultLike = {
	content?: ToolResultContent[];
};

export type Preview = {
	previewLines: string[];
	previewText: string;
	totalLines: number;
	hasMore: boolean;
	remainingLines: number;
};

export type DiffBar = {
	added: number;
	removed: number;
	neutral: number;
};

export type DiffStats = {
	additions: number;
	removals: number;
	hunks: number;
	files: number;
	format: "unified";
	summary: string;
	bar: DiffBar;
};

const homePath = homedir();
const noticePattern = /^(.*)\n\n(\[[\s\S]*\])\s*$/s;
const noFilesFoundMessage = "No files found matching pattern";
const noMatchesFoundMessage = "No matches found";
const emptyDirectoryMessage = "(empty directory)";

function normalizeLineEndings(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function splitLines(text: string): string[] {
	if (text.length === 0) {
		return [];
	}
	return normalizeLineEndings(text).split("\n");
}

export function extractTextContent(result: ToolResultLike | undefined): string {
	if (!result?.content || result.content.length === 0) {
		return "";
	}

	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
}

export function hasImageContent(result: ToolResultLike | undefined): boolean {
	return result?.content?.some((block) => block.type === "image") ?? false;
}

export function splitTrailingNoticeBlock(text: string): { body: string; notice?: string } {
	const normalized = normalizeLineEndings(text);
	const match = normalized.match(noticePattern);
	if (!match) {
		return { body: normalized };
	}

	return {
		body: match[1] ?? "",
		notice: match[2] ?? undefined,
	};
}

export function countLines(text: string): number {
	return splitLines(text).length;
}

export function countReadLines(text: string): number {
	const { body } = splitTrailingNoticeBlock(text);
	return countLines(body);
}

export function countFindResults(text: string): number {
	const { body } = splitTrailingNoticeBlock(text);
	if (body.trim().length === 0 || body.trim() === noFilesFoundMessage) {
		return 0;
	}
	return splitLines(body).filter((line) => line.length > 0).length;
}

export function countLsEntries(text: string): number {
	const { body } = splitTrailingNoticeBlock(text);
	if (body.trim().length === 0 || body.trim() === emptyDirectoryMessage) {
		return 0;
	}
	return splitLines(body).filter((line) => line.length > 0).length;
}

export function countGrepMatches(text: string): number {
	const { body } = splitTrailingNoticeBlock(text);
	if (body.trim().length === 0 || body.trim() === noMatchesFoundMessage) {
		return 0;
	}
	return splitLines(body).filter((line) => /:\d+:\s/.test(line)).length;
}

export function buildPreview(text: string, maxLines = 10): Preview {
	const lines = splitLines(text);
	const previewLines = lines.slice(0, maxLines);
	const remainingLines = Math.max(lines.length - previewLines.length, 0);

	return {
		previewLines,
		previewText: previewLines.join("\n"),
		totalLines: lines.length,
		hasMore: remainingLines > 0,
		remainingLines,
	};
}

export function formatDisplayPath(
	filePath: string,
	options: {
		offset?: number;
		limit?: number;
	} = {},
): string {
	let displayPath = filePath;

	if (isAbsolute(filePath) && (filePath === homePath || filePath.startsWith(`${homePath}/`))) {
		displayPath = `~${filePath.slice(homePath.length)}`;
	}

	if (options.offset !== undefined || options.limit !== undefined) {
		const startLine = options.offset ?? 1;
		const endLine = options.limit !== undefined ? startLine + options.limit - 1 : undefined;
		displayPath += `:${startLine}${endLine !== undefined ? `-${endLine}` : "-"}`;
	}

	return displayPath;
}

export function buildDiffBar(additions: number, removals: number, width = 10): DiffBar {
	const total = additions + removals;
	if (total === 0) {
		return { added: 0, removed: 0, neutral: width };
	}

	let added = additions > 0 ? Math.max(1, Math.round((width * additions) / total)) : 0;
	let removed = removals > 0 ? Math.max(1, Math.round((width * removals) / total)) : 0;

	while (added + removed > width) {
		if (added >= removed && added > 0) {
			added -= 1;
		} else if (removed > 0) {
			removed -= 1;
		}
	}

	while (added + removed < width) {
		if (additions >= removals) {
			added += 1;
		} else {
			removed += 1;
		}
	}

	return {
		added,
		removed,
		neutral: Math.max(width - added - removed, 0),
	};
}

export function getDiffStats(diff: string): DiffStats {
	let additions = 0;
	let removals = 0;
	let explicitHunks = 0;
	let inferredHunks = 0;
	let inChangeGroup = false;

	for (const line of splitLines(diff)) {
		if (line.startsWith("@@")) {
			explicitHunks += 1;
			inChangeGroup = false;
			continue;
		}
		if (line.startsWith("+++") || line.startsWith("---")) {
			inChangeGroup = false;
			continue;
		}
		if (line.startsWith("+")) {
			additions += 1;
			if (!inChangeGroup) {
				inferredHunks += 1;
				inChangeGroup = true;
			}
			continue;
		}
		if (line.startsWith("-")) {
			removals += 1;
			if (!inChangeGroup) {
				inferredHunks += 1;
				inChangeGroup = true;
			}
			continue;
		}

		inChangeGroup = false;
	}

	const hunks = explicitHunks > 0 ? explicitHunks : inferredHunks;
	const files = 1;
	const format = "unified" as const;
	const hunkLabel = hunks === 1 ? "1 hunk" : `${hunks} hunks`;

	return {
		additions,
		removals,
		hunks,
		files,
		format,
		summary: `diff • +${additions} • -${removals} • ${hunkLabel} • ${files} file • ${format}`,
		bar: buildDiffBar(additions, removals),
	};
}
