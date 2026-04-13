import type { DiffComment } from "../types";

export function ensureCollapsedStateForOverallComments(
	collapsedCommentIds: Record<string, boolean>,
	comments: DiffComment[],
): Record<string, boolean> {
	let nextCollapsedCommentIds = collapsedCommentIds;
	for (const comment of comments) {
		if (comment.kind !== "overall" || comment.id in nextCollapsedCommentIds) {
			continue;
		}
		if (nextCollapsedCommentIds === collapsedCommentIds) {
			nextCollapsedCommentIds = { ...collapsedCommentIds };
		}
		nextCollapsedCommentIds[comment.id] = true;
	}
	return nextCollapsedCommentIds;
}
