import { describe, expect, test } from "vitest";
import { collectAnswers, createDraftStore, getLatestDraft, type AnswerDraft } from "../qna-adapter";

const QUESTIONS = [
	{
		id: "runtime",
		question: "Which runtime should we use?",
		options: [
			{ label: "Node", description: "Use Node.js" },
			{ label: "Bun", description: "Use Bun" },
		],
	},
];

describe("getLatestDraft", () => {
	test("returns matching latest draft and ignores cleared state", () => {
		const cleared: AnswerDraft = {
			version: 2,
			sourceEntryId: "msg-1",
			questions: QUESTIONS,
			answers: [],
			responses: [],
			updatedAt: 1,
			state: "cleared",
		};

		const draft = getLatestDraft(
			[
				{ type: "custom", customType: "answer:draft", data: { ...cleared, state: "draft" } },
				{ type: "custom", customType: "answer:draft", data: cleared },
			],
			"msg-1",
			QUESTIONS,
		);

		expect(draft).toBeNull();
	});

	test("returns null when questions differ", () => {
		const draft = getLatestDraft(
			[
				{
					type: "custom",
					customType: "answer:draft",
					data: {
						version: 2,
						sourceEntryId: "msg-1",
						questions: [{ id: "language", question: "Language?" }],
						answers: ["TypeScript"],
						updatedAt: 1,
						state: "draft",
					},
				},
			],
			"msg-1",
			QUESTIONS,
		);

		expect(draft).toBeNull();
	});
});

describe("collectAnswers", () => {
	test("skips custom TUI and returns null in non-TUI mode", async () => {
		let customCalled = false;

		const result = await collectAnswers(
			{
				hasUI: true,
				mode: "rpc",
				ui: {
					custom: async () => {
						customCalled = true;
						return { responses: [] };
					},
				},
			} as any,
			QUESTIONS,
			{
				templates: [],
				initialResponses: [
					{ selectedOptionIndex: 0, customText: "", selectionTouched: false, committed: false },
				],
				onDraftChange: () => {},
			},
		);

		expect(result).toBeNull();
		expect(customCalled).toBe(false);
	});

	test("returns null in print mode", async () => {
		let customCalled = false;

		const result = await collectAnswers(
			{
				hasUI: false,
				mode: "print",
				ui: {
					custom: async () => {
						customCalled = true;
						return { responses: [] };
					},
				},
			} as any,
			QUESTIONS,
			{
				templates: [],
				initialResponses: [
					{ selectedOptionIndex: 0, customText: "", selectionTouched: false, committed: false },
				],
				onDraftChange: () => {},
			},
		);

		expect(result).toBeNull();
		expect(customCalled).toBe(false);
	});
});

 describe("createDraftStore", () => {
	test("saves and clears draft entries", () => {
		const entries: Array<{ type: string; payload: unknown }> = [];
		const pi = {
			appendEntry(type: string, payload: unknown) {
				entries.push({ type, payload });
			},
		} as any;

		const store = createDraftStore(
			pi,
			{ sourceEntryId: "msg-1", questions: QUESTIONS },
			{ enabled: true, autosaveMs: 0, promptOnRestore: true },
		);

		store.schedule([
			{
				selectedOptionIndex: 1,
				customText: "",
				selectionTouched: true,
				committed: true,
			},
		]);
		store.clear();

		expect(entries.length).toBe(2);
		expect(entries[0]?.type).toBe("answer:draft");
		expect((entries[0]?.payload as { state: string }).state).toBe("draft");
		expect((entries[1]?.payload as { state: string }).state).toBe("cleared");
	});
});
