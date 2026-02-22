import { randomBytes } from "node:crypto";
import path from "node:path";
import type { ReviewComment, ReviewModeState, ReviewPriority, ReviewReference, TriagedReviewComment } from "./types";

export const REVIEW_MODE_STATE_VERSION = 1;
export const REVIEW_COMMENT_VERSION = 1;

export const REVIEW_MODE_START_OPTIONS = ["Empty branch", "Current branch"] as const;

export const REVIEW_PRIORITIES: ReviewPriority[] = ["P0", "P1", "P2", "P3"];

export function createInactiveReviewModeState(): ReviewModeState {
	return {
		version: REVIEW_MODE_STATE_VERSION,
		active: false,
	};
}

export function isReviewModeState(value: unknown): value is ReviewModeState {
	if (!value || typeof value !== "object") {
		return false;
	}

	const state = value as Partial<ReviewModeState>;
	return state.version === REVIEW_MODE_STATE_VERSION && typeof state.active === "boolean";
}

export function isReviewPriority(value: unknown): value is ReviewPriority {
	return typeof value === "string" && REVIEW_PRIORITIES.includes(value as ReviewPriority);
}

export function normalizeReviewPriority(value: unknown): ReviewPriority | null {
	if (typeof value !== "string") {
		return null;
	}
	const normalized = value.trim().toUpperCase();
	return isReviewPriority(normalized) ? normalized : null;
}

export function parseReviewPaths(value: string): string[] {
	return value
		.split(/\s+/)
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}

export function normalizeFilePath(filePath: unknown): string {
	if (typeof filePath !== "string") {
		return "";
	}

	const trimmed = filePath.trim().replace(/\\/g, "/");
	if (!trimmed) {
		return "";
	}
	const normalized = path.posix.normalize(trimmed);
	if (normalized === ".") {
		return "";
	}
	return normalized.startsWith("./") ? normalized.slice(2) : normalized;
}

export function normalizeReviewReference(reference: unknown): ReviewReference | null {
	if (!reference || typeof reference !== "object") {
		return null;
	}

	const value = reference as Partial<ReviewReference>;
	const filePath = normalizeFilePath(value.filePath);
	if (!filePath) {
		return null;
	}

	const startLine = Number(value.startLine);
	if (!Number.isInteger(startLine) || startLine < 1) {
		return null;
	}

	if (value.endLine === undefined) {
		return { filePath, startLine };
	}

	const endLine = Number(value.endLine);
	if (!Number.isInteger(endLine) || endLine < startLine) {
		return null;
	}

	return {
		filePath,
		startLine,
		endLine,
	};
}

export function formatReference(reference: ReviewReference): string {
	if (reference.endLine && reference.endLine !== reference.startLine) {
		return `${reference.filePath}:${reference.startLine}-${reference.endLine}`;
	}
	return `${reference.filePath}:${reference.startLine}`;
}

export function createReviewRunId(): string {
	return `review-${randomBytes(4).toString("hex")}`;
}

export function createReviewCommentId(): string {
	return `comment-${randomBytes(4).toString("hex")}`;
}

export function summarizeSnippet(value: string, maxLength: number = 80): string {
	const singleLine = value.replace(/\s+/g, " ").trim();
	if (!singleLine) {
		return "";
	}
	if (singleLine.length <= maxLength) {
		return singleLine;
	}
	return `${singleLine.slice(0, maxLength - 3)}...`;
}

export type ParsedPrReference = {
	prNumber: number;
	ghRef: string;
};

export function parsePrLocator(ref: string): ParsedPrReference | null {
	const trimmed = ref.trim();
	if (!trimmed) {
		return null;
	}

	const numeric = Number.parseInt(trimmed, 10);
	if (Number.isInteger(numeric) && numeric > 0 && String(numeric) === trimmed) {
		return {
			prNumber: numeric,
			ghRef: String(numeric),
		};
	}

	const urlMatch = trimmed.match(/^(?:https?:\/\/)?github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/i);
	if (!urlMatch) {
		return null;
	}

	const prNumber = Number.parseInt(urlMatch[3], 10);
	if (!Number.isInteger(prNumber) || prNumber <= 0) {
		return null;
	}

	return {
		prNumber,
		ghRef: `https://github.com/${urlMatch[1]}/${urlMatch[2]}/pull/${prNumber}`,
	};
}

export function parsePrReference(ref: string): number | null {
	return parsePrLocator(ref)?.prNumber ?? null;
}

export function getReviewTargetHint(target: { type: string } & Record<string, unknown>): string {
	switch (target.type) {
		case "uncommitted":
			return "Review uncommitted changes";
		case "baseBranch":
			return "Review against a base branch (local)";
		case "commit":
			return "Review a commit";
		case "custom":
			return "Custom review instructions";
		case "pullRequest":
			return "Review a pull request (GitHub PR)";
		case "folder":
			return "Review a folder (or more) (snapshot, not diff)";
		default:
			return "review target";
	}
}

export function formatReviewSummaryMessage(options: {
	targetHint?: string;
	kept: TriagedReviewComment[];
	discardedCount: number;
	totalCount: number;
}): string {
	const lines: string[] = ["Code Review Summary"];
	if (options.targetHint?.trim()) {
		lines.push(`Target: ${options.targetHint.trim()}`);
	}

	lines.push("");
	lines.push("Comments:");
	if (options.kept.length === 0) {
		lines.push("(none)");
		return lines.join("\n");
	}

	for (let i = 0; i < options.kept.length; i++) {
		const finding = options.kept[i];
		lines.push(`${i + 1}. [${finding.priority}] ${finding.comment}`);
		if (finding.references.length > 0) {
			lines.push(`   References: ${finding.references.map(formatReference).join(", ")}`);
		}
		if (finding.note?.trim()) {
			lines.push(`   Note: ${finding.note.trim()}`);
		}
	}

	return lines.join("\n");
}

export function toTriagedReviewComment(comment: ReviewComment): TriagedReviewComment {
	return {
		id: comment.id,
		keep: true,
		priority: comment.priority,
		comment: comment.comment,
		references: comment.references,
		originalPriority: comment.priority,
	};
}
