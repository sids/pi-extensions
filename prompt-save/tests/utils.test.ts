import { describe, expect, test } from "bun:test";
import {
	MUTATION_ENTRY_TYPE,
	STATE_ENTRY_TYPE,
	appendPromptToEditor,
	buildPromptPreview,
	createAddPromptSaveMutation,
	createDeletePromptSaveMutation,
	createEmptyPromptSaveState,
	getLatestPromptSaveStateFromEntries,
} from "../utils";

describe("getLatestPromptSaveStateFromEntries", () => {
	test("replays mutations across session branches", () => {
		const state = getLatestPromptSaveStateFromEntries([
			{
				type: "custom",
				customType: MUTATION_ENTRY_TYPE,
				parentId: "branch-a",
				data: createAddPromptSaveMutation({ id: "prompt-1", text: "first", createdAt: 1 }),
			},
			{
				type: "custom",
				customType: MUTATION_ENTRY_TYPE,
				parentId: "branch-b",
				data: createAddPromptSaveMutation({ id: "prompt-2", text: "second", createdAt: 2 }),
			},
		]);

		expect(state).toEqual({
			version: 1,
			items: [
				{ id: "prompt-1", text: "first", createdAt: 1 },
				{ id: "prompt-2", text: "second", createdAt: 2 },
			],
		});
	});

	test("keeps compatibility with old snapshots and applies later mutations", () => {
		const state = getLatestPromptSaveStateFromEntries([
			{
				type: "custom",
				customType: STATE_ENTRY_TYPE,
				data: {
					version: 1,
					items: [{ id: "prompt-1", text: "first", createdAt: 1 }],
				},
			},
			{
				type: "custom",
				customType: STATE_ENTRY_TYPE,
				data: {
					version: 2,
					items: [{ id: "prompt-2", text: "broken", createdAt: 2 }],
				},
			},
			{
				type: "custom",
				customType: MUTATION_ENTRY_TYPE,
				data: createAddPromptSaveMutation({ id: "prompt-3", text: "third", createdAt: 3 }),
			},
			{
				type: "custom",
				customType: MUTATION_ENTRY_TYPE,
				data: createDeletePromptSaveMutation("prompt-1"),
			},
		]);

		expect(state).toEqual({
			version: 1,
			items: [{ id: "prompt-3", text: "third", createdAt: 3 }],
		});
	});

	test("returns an empty state when no snapshot exists", () => {
		expect(getLatestPromptSaveStateFromEntries([])).toEqual(createEmptyPromptSaveState());
	});
});

describe("appendPromptToEditor", () => {
	test("populates the editor when it is empty", () => {
		expect(appendPromptToEditor("", "saved prompt")).toBe("saved prompt");
		expect(appendPromptToEditor("   ", "saved prompt")).toBe("saved prompt");
	});

	test("appends using a single newline separator when the editor already has text", () => {
		expect(appendPromptToEditor("current prompt", "saved prompt")).toBe("current prompt\nsaved prompt");
		expect(appendPromptToEditor("current prompt\n", "saved prompt")).toBe("current prompt\nsaved prompt");
		expect(appendPromptToEditor("current prompt\n\n", "\nsaved prompt")).toBe("current prompt\nsaved prompt");
	});
});

describe("buildPromptPreview", () => {
	test("returns the first line and literal additional line count for multiline prompts", () => {
		expect(buildPromptPreview("first line\n\nsecond line\nthird line")).toEqual({
			label: "first line",
			additionalLineCount: 3,
		});
	});

	test("normalizes CRLF and keeps single-line prompts suffix-free", () => {
		expect(buildPromptPreview("first line only")).toEqual({
			label: "first line only",
			additionalLineCount: 0,
		});
		expect(buildPromptPreview("first line\r\nsecond line")).toEqual({
			label: "first line",
			additionalLineCount: 1,
		});
	});

	test("uses fallbacks for blank prompts and blank first lines", () => {
		expect(buildPromptPreview("")).toEqual({
			label: "(blank prompt)",
			additionalLineCount: 0,
		});
		expect(buildPromptPreview("\nsecond line")).toEqual({
			label: "(blank first line)",
			additionalLineCount: 1,
		});
	});
});
