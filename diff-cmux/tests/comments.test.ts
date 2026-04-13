import { describe, expect, test } from "bun:test";
import { appendCommentsToEditor, appendTextToEditor, findReusableDraftComment, formatCommentsForEditor, isDiffComment, isEmptyDraftComment, removeCommentById, updateCommentText, validateDiffComments } from "../comments";
import type { DiffComment, ResolvedDiffTarget } from "../types";

const TARGET: ResolvedDiffTarget = {
	type: "uncommitted",
	label: "Uncommitted changes",
	subtitle: "Working tree compared with HEAD",
	baseRev: "HEAD",
	headRev: "HEAD",
	hasHead: true,
};

const COMMENTS: DiffComment[] = [
	{
		id: "line-1",
		kind: "line",
		text: "Please rename this.",
		createdAt: 1,
		updatedAt: 1,
		sentAt: null,
		fileId: "file-1",
		path: "src/foo.ts",
		oldPath: null,
		newPath: "src/foo.ts",
		lineNumber: 42,
		side: "new",
		changeKey: "I42",
		excerpt: "const badName = true;",
	},
	{
		id: "file-1",
		kind: "file",
		text: "Consider extracting this helper.",
		createdAt: 2,
		updatedAt: 2,
		sentAt: null,
		fileId: "file-1",
		path: "src/foo.ts",
		oldPath: null,
		newPath: "src/foo.ts",
	},
	{
		id: "overall-1",
		kind: "overall",
		text: "Looks close, but needs another pass.",
		createdAt: 3,
		updatedAt: 3,
		sentAt: null,
	},
];

describe("comment validation", () => {
	test("accepts valid comments", () => {
		expect(COMMENTS.every(isDiffComment)).toBeTrue();
		expect(validateDiffComments(COMMENTS)).toEqual(COMMENTS);
	});

	test("rejects invalid comments", () => {
		expect(() => validateDiffComments([{ kind: "line" }])).toThrow("One or more comments were invalid.");
	});
});

describe("formatCommentsForEditor", () => {
	test("formats target, per-file, and overall sections", () => {
		expect(formatCommentsForEditor(TARGET, COMMENTS)).toBe(`Looks close, but needs another pass.

./src/foo.ts:42 (new)
   Please rename this.

./src/foo.ts
   Consider extracting this helper.
`);
	});
});

describe("draft helpers", () => {
	test("reuses empty overall drafts instead of creating duplicates", () => {
		expect(findReusableDraftComment([{ ...COMMENTS[2]!, text: "", sentAt: null }], { kind: "overall" })?.id).toBe("overall-1");
		expect(findReusableDraftComment(COMMENTS, { kind: "overall" })).toBeNull();
	});

	test("finds matching empty file drafts", () => {
		expect(findReusableDraftComment(COMMENTS, { kind: "file", fileId: "file-1" }) ?? null).toBeNull();
		expect(findReusableDraftComment([{ ...COMMENTS[1]!, text: "", sentAt: null }], { kind: "file", fileId: "file-1" })?.id).toBe("file-1");
	});

	test("removes comments by id", () => {
		expect(removeCommentById(COMMENTS, "overall-1").map((comment) => comment.id)).toEqual(["line-1", "file-1"]);
	});

	test("detects empty drafts", () => {
		expect(isEmptyDraftComment({ ...COMMENTS[2]!, text: "   " })).toBeTrue();
		expect(isEmptyDraftComment(COMMENTS[2]!)).toBeFalse();
	});
});

describe("appendTextToEditor", () => {
	test("replaces empty editor content", () => {
		expect(appendTextToEditor("   ", "next")).toBe("next");
	});

	test("appends on a new line when the editor already has text", () => {
		expect(appendTextToEditor("current text\n", "next")).toBe("current text\nnext");
	});
});

describe("appendCommentsToEditor", () => {
	test("appends the formatted comments to the editor", async () => {
		let editorText = "existing draft";
		const ui = {
			getEditorText: () => editorText,
			setEditorText: (value: string) => {
				editorText = value;
			},
		};

		await appendCommentsToEditor(ui, TARGET, COMMENTS);
		expect(editorText).toContain("existing draft\n\nLooks close, but needs another pass.\n\n./src/foo.ts:42 (new)");
		expect(editorText.endsWith("./src/foo.ts\n   Consider extracting this helper.\n\n")).toBeTrue();
	});

	test("adds an extra trailing newline when appending a single comment", async () => {
		let editorText = "existing draft";
		const ui = {
			getEditorText: () => editorText,
			setEditorText: (value: string) => {
				editorText = value;
			},
		};

		await appendCommentsToEditor(ui, TARGET, [COMMENTS[0]!]);
		expect(editorText).toContain("existing draft\n\n./src/foo.ts:42 (new)");
		expect(editorText.endsWith("./src/foo.ts:42 (new)\n   Please rename this.\n\n")).toBeTrue();
	});
});

describe("updateCommentText", () => {
	test("clears sent state when a sent comment is edited", () => {
		const updated = updateCommentText({ ...COMMENTS[0]!, sentAt: 123 }, "Changed");
		expect(updated.sentAt).toBeNull();
		expect(updated.text).toBe("Changed");
	});
});
