import { describe, expect, test } from "bun:test";
import {
	formatReviewReferenceCount,
	getReviewCommentsForRun,
	normalizeAddReviewCommentInput,
	registerAddReviewCommentTool,
	REVIEW_COMMENT_ENTRY_TYPE,
} from "../comments";

describe("formatReviewReferenceCount", () => {
	test("matches review comment reference summary text", () => {
		expect(formatReviewReferenceCount(0)).toBe("0 references (ctrl+o to view)");
		expect(formatReviewReferenceCount(3)).toBe("3 references (ctrl+o to view)");
	});
});

describe("normalizeAddReviewCommentInput", () => {
	test("validates required fields", () => {
		expect(normalizeAddReviewCommentInput({ priority: "P1", comment: "" })).toEqual({
			error: "comment must be non-empty.",
		});

		expect(normalizeAddReviewCommentInput({ priority: "P9", comment: "x" })).toEqual({
			error: "priority must be one of P0, P1, P2, or P3.",
		});
	});

	test("normalizes references", () => {
		const result = normalizeAddReviewCommentInput({
			priority: "P2",
			comment: "  Leak file handle  ",
			references: [{ filePath: " ./src\\file.ts ", startLine: 10, endLine: 10 }],
		});

		if ("error" in result) {
			throw new Error(result.error);
		}

		expect(result.value).toEqual({
			priority: "P2",
			comment: "Leak file handle",
			references: [{ filePath: "src/file.ts", startLine: 10, endLine: 10 }],
		});
	});

	test("preserves leading priority tags in comment text", () => {
		const bracketed = normalizeAddReviewCommentInput({
			priority: "P1",
			comment: "[P2] Null check is missing",
			references: [],
		});
		if ("error" in bracketed) {
			throw new Error(bracketed.error);
		}
		expect(bracketed.value.comment).toBe("[P2] Null check is missing");

		const prefixed = normalizeAddReviewCommentInput({
			priority: "P1",
			comment: "P3: Null check is missing",
			references: [],
		});
		if ("error" in prefixed) {
			throw new Error(prefixed.error);
		}
		expect(prefixed.value.comment).toBe("P3: Null check is missing");
	});
});

describe("registerAddReviewCommentTool", () => {
	test("persists comments tied to active runId", async () => {
		let registeredTool:
			| {
					execute: (toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) => Promise<any>;
					promptSnippet?: string;
			  }
			| undefined;
		const appended: Array<{ type: string; data: any }> = [];

		registerAddReviewCommentTool(
			{
				registerTool: (tool: NonNullable<typeof registeredTool>) => {
					registeredTool = tool;
				},
				appendEntry: (type: string, data: any) => appended.push({ type, data }),
			} as any,
			{
				getState: () => ({ version: 1, active: true, runId: "run-123" }),
				addReviewCommentSchema: {},
			},
		);

		if (!registeredTool) {
			throw new Error("Tool execute handler missing");
		}

		expect(registeredTool.promptSnippet).toBe(
			"Record one review finding with priority and optional file/line references.",
		);

		const result = await registeredTool.execute(
			"call-1",
			{
				priority: "P1",
				comment: "Possible null dereference",
				references: [{ filePath: "src/a.ts", startLine: 42 }],
			},
			undefined,
			undefined,
			{},
		);

		expect(result.isError).toBeUndefined();
		expect(appended.length).toBe(1);
		expect(appended[0].type).toBe(REVIEW_COMMENT_ENTRY_TYPE);
		expect(appended[0].data.runId).toBe("run-123");
		expect(appended[0].data.priority).toBe("P1");
	});

	test("throws when review mode is off", async () => {
		let execute:
			| ((toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) => Promise<any>)
			| undefined;

		registerAddReviewCommentTool(
			{
				registerTool: (tool: { execute: NonNullable<typeof execute> }) => {
					execute = tool.execute;
				},
				appendEntry: () => {},
			} as any,
			{
				getState: () => ({ version: 1, active: false }),
				addReviewCommentSchema: {},
			},
		);

		if (!execute) {
			throw new Error("Tool execute handler missing");
		}

		let error: unknown;
		try {
			await execute("call-1", { priority: "P1", comment: "x" }, undefined, undefined, {});
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("inactive");
	});
});

describe("getReviewCommentsForRun", () => {
	test("filters by run id", () => {
		const comments = getReviewCommentsForRun(
			{
				sessionManager: {
					getEntries: () => [
						{
							type: "custom",
							customType: "review-mode:comment",
							data: {
								version: 1,
								id: "a",
								runId: "run-1",
								priority: "P1",
								comment: "one",
								references: [],
								createdAt: 1,
							},
						},
						{
							type: "custom",
							customType: "review-mode:comment",
							data: {
								version: 1,
								id: "b",
								runId: "run-2",
								priority: "P2",
								comment: "two",
								references: [],
								createdAt: 2,
							},
						},
					],
				},
			} as any,
			"run-1",
		);

		expect(comments.map((comment) => comment.id)).toEqual(["a"]);
	});

	test("ignores malformed persisted references instead of throwing", () => {
		const run = () =>
			getReviewCommentsForRun(
				{
					sessionManager: {
						getEntries: () => [
							{
								type: "custom",
								customType: "review-mode:comment",
								data: {
									version: 1,
									id: "bad",
									runId: "run-1",
									priority: "P1",
									comment: "bad",
									references: [{}],
									createdAt: 1,
								},
							},
							{
								type: "custom",
								customType: "review-mode:comment",
								data: {
									version: 1,
									id: "good",
									runId: "run-1",
									priority: "P2",
									comment: "good",
									references: [{ filePath: "src/a.ts", startLine: 4 }],
									createdAt: 2,
								},
							},
						],
					},
				} as any,
				"run-1",
			);

		expect(run).not.toThrow();
		expect(run().map((comment) => comment.id)).toEqual(["good"]);
	});
});
