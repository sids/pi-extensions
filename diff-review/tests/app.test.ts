import { describe, expect, test } from "vitest";
import { getSubmittedCommentIds, markSubmittedCommentsSent } from "../web/app";
import type { DiffOverallComment } from "../types";

function comment(overrides: Partial<DiffOverallComment> = {}): DiffOverallComment {
	return {
		id: "comment-1",
		kind: "overall",
		text: "draft",
		createdAt: 100,
		updatedAt: 200,
		sentAt: null,
		...overrides,
	};
}

describe("comment send reconciliation", () => {
	test("marks submitted comments as sent when the draft is unchanged", () => {
		const current = [comment()];
		const sent = markSubmittedCommentsSent(current, [{ id: "comment-1", text: "draft", updatedAt: 200 }], 300);

		expect(sent[0]?.sentAt).toBe(300);
	});

	test("does not mark newer edits as sent by an older response", () => {
		const current = [comment({ text: "edited", updatedAt: 250 })];
		const submitted = [{ id: "comment-1", text: "draft", updatedAt: 200 }];

		expect(getSubmittedCommentIds(current, submitted)).toEqual([]);
		expect(markSubmittedCommentsSent(current, submitted, 300)[0]?.sentAt).toBeNull();
	});
});
