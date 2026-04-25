import { describe, expect, test } from "bun:test";
import {
	buildSessionChangeSummaryPrompt,
	extractAssistantText,
	formatChangeSummary,
	parseChangeSummaryResult,
	summarizeChangesFromSessionHistory,
} from "../change-summary";

function createModel() {
	return {
		provider: "anthropic",
		id: "claude-sonnet",
		api: "anthropic-messages",
		name: "Claude Sonnet",
		reasoning: true,
		baseUrl: "",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_000,
	} as any;
}

function createSessionEntries() {
	return [
		{
			id: "user-1",
			parentId: null,
			type: "message",
			timestamp: "2026-01-01T00:00:00.000Z",
			message: {
				role: "user",
				content: [{ type: "text", text: "Add review mode change summaries." }],
				timestamp: 1,
			},
		},
		{
			id: "assistant-1",
			parentId: "user-1",
			type: "message",
			timestamp: "2026-01-01T00:00:01.000Z",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Implemented the review summary behavior." }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 2,
			},
		},
		{
			id: "other-branch",
			parentId: "user-1",
			type: "message",
			timestamp: "2026-01-01T00:00:02.000Z",
			message: {
				role: "user",
				content: [{ type: "text", text: "This branch should not be summarized." }],
				timestamp: 3,
			},
		},
	] as any[];
}

describe("buildSessionChangeSummaryPrompt", () => {
	test("asks for goal and motivation instead of implementation details", () => {
		const prompt = buildSessionChangeSummaryPrompt();

		expect(prompt).toContain("Summarize the changes made so far in this conversation");
		expect(prompt).toContain("Focus on the likely goal, motivation, context, and expected outcome");
		expect(prompt).toContain("Do not produce a changelog, file-by-file walkthrough");
		expect(prompt).toContain("Avoid naming files, functions, tests, package metadata");
		expect(prompt).toContain("Output only a JSON object");
		expect(prompt).toContain('{ "summary": "Markdown summary text without a title heading" }');
	});
});

describe("summarizeChangesFromSessionHistory", () => {
	test("uses source branch history, current model/auth, session cache, and omits reasoning", async () => {
		const model = createModel();
		const authCalls: any[] = [];
		const completeCalls: any[] = [];

		const summary = await summarizeChangesFromSessionHistory(
			{
				cwd: "/tmp/project",
				model,
				modelRegistry: {
					getApiKeyAndHeaders: async (requestedModel: any) => {
						authCalls.push(requestedModel);
						return { ok: true, apiKey: "api-key", headers: { "x-test": "yes" } };
					},
				},
				getSystemPrompt: () => "Pi system prompt",
				sessionManager: {
					getEntries: () => createSessionEntries(),
					getEntry: (id: string) => createSessionEntries().find((entry) => entry.id === id),
					getLeafId: () => "other-branch",
					getSessionId: () => "session-1",
				},
			} as any,
			"assistant-1",
			{
				now: () => 123,
				complete: async (...args: any[]) => {
					completeCalls.push(args);
					return {
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "hidden" },
							{
								type: "text",
								text: JSON.stringify({ summary: "Intent: make review startup easier to understand." }),
							},
						],
						stopReason: "stop",
					} as any;
				},
			},
		);

		expect(summary).toBe("# Summary of changes\n\nIntent: make review startup easier to understand.");
		expect(authCalls).toEqual([model]);
		expect(completeCalls).toHaveLength(1);
		expect(completeCalls[0][0]).toBe(model);
		expect(completeCalls[0][1].systemPrompt).toBe("Pi system prompt");
		expect(completeCalls[0][1].messages.map((message: any) => message.content)).toEqual([
			[{ type: "text", text: "Add review mode change summaries." }],
			[{ type: "text", text: "Implemented the review summary behavior." }],
			[{ type: "text", text: expect.stringContaining("Summarize the changes made so far") }],
		]);
		expect(JSON.stringify(completeCalls[0][1].messages)).not.toContain("This branch should not be summarized");
		expect(completeCalls[0][1].messages.at(-1)).toEqual({
			role: "user",
			content: [{ type: "text", text: expect.stringContaining("Summarize the changes made so far") }],
			timestamp: 123,
		});
		expect(completeCalls[0][2]).toEqual({
			apiKey: "api-key",
			headers: { "x-test": "yes" },
			maxTokens: 1_000,
			sessionId: "session-1",
		});
		expect("reasoning" in completeCalls[0][2]).toBe(false);
	});

	test("throws provider error results from completion", async () => {
		const model = createModel();

		await expect(
			summarizeChangesFromSessionHistory(
				{
					cwd: "/tmp/project",
					model,
					modelRegistry: {
						getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "api-key" }),
					},
					getSystemPrompt: () => "Pi system prompt",
					sessionManager: {
						getEntries: () => createSessionEntries(),
						getEntry: (id: string) => createSessionEntries().find((entry) => entry.id === id),
						getLeafId: () => "assistant-1",
						getSessionId: () => "session-1",
					},
				} as any,
				"assistant-1",
				{
					complete: async () => ({
						role: "assistant",
						content: [],
						stopReason: "error",
						errorMessage: "Instructions are required",
					}) as any,
				},
			),
		).rejects.toThrow("Instructions are required");
	});

	test("returns null when no current model is selected", async () => {
		const summary = await summarizeChangesFromSessionHistory(
			{
				sessionManager: {
					getEntries: () => createSessionEntries(),
					getEntry: (id: string) => createSessionEntries().find((entry) => entry.id === id),
					getLeafId: () => "assistant-1",
					getSessionId: () => "session-1",
				},
			} as any,
			"assistant-1",
		);

		expect(summary).toBeNull();
	});

	test("returns null when source branch is unavailable", async () => {
		const summary = await summarizeChangesFromSessionHistory(
			{
				model: createModel(),
				sessionManager: {
					getEntries: () => createSessionEntries(),
					getEntry: () => undefined,
					getLeafId: () => "assistant-1",
					getSessionId: () => "session-1",
				},
			} as any,
			"missing-leaf",
		);

		expect(summary).toBeNull();
	});
});

describe("parseChangeSummaryResult", () => {
	test("extracts summary from JSON object responses", () => {
		expect(parseChangeSummaryResult('{"summary":"Intent: update review startup."}')).toBe(
			"Intent: update review startup.",
		);
		expect(parseChangeSummaryResult('```json\n{"summary":"Intent: update review startup."}\n```')).toBe(
			"Intent: update review startup.",
		);
		expect(parseChangeSummaryResult('{"summary":""}')).toBeNull();
		expect(parseChangeSummaryResult('not json')).toBeNull();
		expect(parseChangeSummaryResult('{"text":"missing summary"}')).toBeNull();
	});
});

describe("formatChangeSummary", () => {
	test("adds the summary title and replaces generic generated headings", () => {
		expect(formatChangeSummary("Intent: update review startup.")).toBe(
			"# Summary of changes\n\nIntent: update review startup.",
		);
		expect(formatChangeSummary("## Summary\n\nIntent: update review startup.")).toBe(
			"# Summary of changes\n\nIntent: update review startup.",
		);
		expect(formatChangeSummary("# Summary of changes\n\nIntent: update review startup.")).toBe(
			"# Summary of changes\n\nIntent: update review startup.",
		);
	});
});

describe("extractAssistantText", () => {
	test("extracts only text blocks", () => {
		const text = extractAssistantText({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "do not include" },
				{ type: "text", text: "first" },
				{ type: "toolCall", id: "call-1", name: "tool", arguments: {} },
				{ type: "text", text: "second" },
			],
		} as any);

		expect(text).toBe("first\nsecond");
	});
});
