import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ReviewModeState } from "./types";
import type { PersistedReviewComment, ReviewPriority, ReviewReference } from "./types";
import {
	createReviewCommentId,
	formatReference,
	normalizeReviewPriority,
	normalizeReviewReference,
	REVIEW_COMMENT_VERSION,
} from "./utils";

const require = createRequire(import.meta.url);

function requirePiTui() {
	try {
		return require("@mariozechner/pi-tui");
	} catch (error) {
		const code = (error as { code?: string }).code;
		if (code !== "MODULE_NOT_FOUND") {
			throw error;
		}
		return require(path.join(os.homedir(), ".bun", "install", "global", "node_modules", "@mariozechner", "pi-tui"));
	}
}

function createText(text: string) {
	const { Text } = requirePiTui() as {
		Text: new (text: string, x: number, y: number) => unknown;
	};
	return new Text(text, 0, 0);
}

export const REVIEW_COMMENT_ENTRY_TYPE = "review-mode:comment";

type AddReviewCommentParams = {
	priority?: string;
	comment?: string;
	references?: ReviewReference[];
};

export type NormalizedReviewCommentInput = {
	priority: ReviewPriority;
	comment: string;
	references: ReviewReference[];
};

export function formatReviewReferenceCount(referenceCount: number): string {
	return `${referenceCount} references (ctrl+o to view)`;
}

export function normalizeAddReviewCommentInput(
	params: AddReviewCommentParams,
): { value: NormalizedReviewCommentInput } | { error: string } {
	const priority = normalizeReviewPriority(params.priority);
	if (!priority) {
		return { error: "priority must be one of P0, P1, P2, or P3." };
	}

	const comment = String(params.comment ?? "").trim();
	if (!comment) {
		return { error: "comment must be non-empty." };
	}

	const references: ReviewReference[] = [];
	for (const rawReference of params.references ?? []) {
		const normalized = normalizeReviewReference(rawReference);
		if (!normalized) {
			return {
				error:
					"Each reference must include a non-empty filePath, startLine >= 1, and endLine >= startLine when provided.",
			};
		}
		references.push(normalized);
	}

	return {
		value: {
			priority,
			comment,
			references,
		},
	};
}

export function isPersistedReviewComment(value: unknown): value is PersistedReviewComment {
	if (!value || typeof value !== "object") {
		return false;
	}

	const record = value as Partial<PersistedReviewComment>;
	if (
		record.version !== REVIEW_COMMENT_VERSION ||
		typeof record.id !== "string" ||
		typeof record.runId !== "string" ||
		typeof record.comment !== "string" ||
		typeof record.createdAt !== "number"
	) {
		return false;
	}

	if (!normalizeReviewPriority(record.priority)) {
		return false;
	}

	if (!Array.isArray(record.references)) {
		return false;
	}

	for (const reference of record.references) {
		if (!normalizeReviewReference(reference)) {
			return false;
		}
	}

	return true;
}

export function getReviewCommentsForRun(ctx: ExtensionContext, runId: string): PersistedReviewComment[] {
	const comments: PersistedReviewComment[] = [];
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "custom" || entry.customType !== REVIEW_COMMENT_ENTRY_TYPE) {
			continue;
		}
		if (!isPersistedReviewComment(entry.data)) {
			continue;
		}
		if (entry.data.runId !== runId) {
			continue;
		}
		comments.push(entry.data);
	}
	return comments;
}

export function registerAddReviewCommentTool(
	pi: ExtensionAPI,
	dependencies: {
		getState: () => ReviewModeState;
		addReviewCommentSchema: unknown;
	},
) {
	pi.registerTool({
		name: "add_review_comment",
		label: "add_review_comment",
		description:
			"Record one review finding with priority and optional file/line references. This tool is only available while review mode is active.",
		parameters: dependencies.addReviewCommentSchema,
		renderCall(args, theme) {
			const priority = normalizeReviewPriority(args.priority) ?? "P?";
			return createText(
				`${theme.fg("toolTitle", theme.bold("add_review_comment "))}${theme.fg("accent", `[${priority}]`)}`,
			);
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as PersistedReviewComment | undefined;
			if (!details) {
				const text = result.content.find((item) => item.type === "text");
				return createText(text?.type === "text" ? text.text : "(no output)");
			}

			const referenceCount = details.references.length;
			const lines = [
				details.comment,
				theme.fg("dim", formatReviewReferenceCount(referenceCount)),
			];

			if (expanded && referenceCount > 0) {
				for (const reference of details.references) {
					lines.push(theme.fg("dim", `- ${formatReference(reference)}`));
				}
			}
			return createText(lines.join("\n"));
		},
		async execute(
			_toolCallId,
			params: AddReviewCommentParams,
			_signal,
			_onUpdate,
			_ctx,
		): Promise<AgentToolResult<PersistedReviewComment>> {
			const state = dependencies.getState();
			if (!state.active || !state.runId) {
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: "add_review_comment is unavailable while review mode is inactive. Start review mode with /review first.",
						},
					],
				};
			}

			const normalized = normalizeAddReviewCommentInput(params);
			if ("error" in normalized) {
				return {
					isError: true,
					content: [{ type: "text", text: normalized.error }],
				};
			}

			const comment: PersistedReviewComment = {
				version: REVIEW_COMMENT_VERSION,
				id: createReviewCommentId(),
				runId: state.runId,
				priority: normalized.value.priority,
				comment: normalized.value.comment,
				references: normalized.value.references,
				createdAt: Date.now(),
			};
			pi.appendEntry(REVIEW_COMMENT_ENTRY_TYPE, comment);

			return {
				content: [{ type: "text", text: `Recorded review comment (${comment.priority}).` }],
				details: comment,
			};
		},
	});
}
