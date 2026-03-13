import type { TruncationResult } from "@mariozechner/pi-coding-agent";

export const FETCH_URL_PREVIEW_LINES = 10;

type TruncationSummary = Pick<
	TruncationResult,
	"outputLines" | "totalLines" | "outputBytes" | "totalBytes"
>;

function formatByteSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes}B`;
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)}KB`;
	}
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function splitFetchUrlPreview(
	text: string,
	maxLines: number = FETCH_URL_PREVIEW_LINES,
): { previewLines: string[]; remainingLines: number } {
	if (!text) {
		return { previewLines: [], remainingLines: 0 };
	}

	const lines = text.split("\n");
	const previewLines = lines.slice(0, maxLines);
	return {
		previewLines,
		remainingLines: Math.max(0, lines.length - previewLines.length),
	};
}

export function formatFetchUrlTruncationNotice(
	truncation: TruncationSummary,
	fullOutputPath: string,
): string {
	return `[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatByteSize(
		truncation.outputBytes,
	)} of ${formatByteSize(truncation.totalBytes)}). Full output saved to: ${fullOutputPath}]`;
}

export function formatFetchUrlTruncationWarning(
	truncation: TruncationSummary,
	fullOutputPath: string,
): string {
	return `Output truncated (${truncation.outputLines}/${truncation.totalLines} lines, ${formatByteSize(
		truncation.outputBytes,
	)} of ${formatByteSize(truncation.totalBytes)}). Full output: ${fullOutputPath}`;
}
