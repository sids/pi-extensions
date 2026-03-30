import { describe, expect, test } from "bun:test";
import type { QnAResponse } from "../../shared/qna-tui";
import {
	buildRequestUserInputResponse,
	buildRequestUserInputSummary,
	normalizeRequestUserInputQuestions,
	registerRequestUserInputTool,
	summarizeRequestUserInputAnswer,
} from "../request-user-input";

describe("normalizeRequestUserInputQuestions", () => {
	test("trims ids and defaults options", () => {
		const result = normalizeRequestUserInputQuestions([
			{ id: " runtime ", header: "Runtime", question: "Which runtime?" },
		]);

		if ("error" in result) {
			throw new Error(result.error);
		}

		expect(result.questions[0]).toEqual({
			id: "runtime",
			header: "Runtime",
			question: "Which runtime?",
			options: [],
		});
	});

	test("rejects duplicate ids", () => {
		const result = normalizeRequestUserInputQuestions([
			{ id: "runtime", header: "One", question: "Q1" },
			{ id: "runtime", header: "Two", question: "Q2" },
		]);

		expect("error" in result).toBe(true);
		if ("error" in result) {
			expect(result.error).toContain("Duplicate id: runtime");
		}
	});
});

describe("buildRequestUserInputResponse", () => {
	test("returns selected options and raw custom text", () => {
		const normalized = normalizeRequestUserInputQuestions([
			{
				id: "runtime",
				header: "Runtime",
				question: "Which runtime?",
				options: [
					{ label: "Node", description: "Use Node.js" },
					{ label: "Bun", description: "Use Bun" },
				],
			},
			{
				id: "notes",
				header: "Notes",
				question: "Any constraints?",
			},
		]);
		if ("error" in normalized) {
			throw new Error(normalized.error);
		}

		const responses: QnAResponse[] = [
			{
				selectedOptionIndex: 2,
				customText: "Need Bun APIs",
				selectionTouched: true,
				committed: true,
			},
			{
				selectedOptionIndex: 0,
				customText: "Ship in two phases",
				selectionTouched: true,
				committed: true,
			},
		];

		const response = buildRequestUserInputResponse(normalized.questions, responses);
		expect(response.answers.runtime.answers).toEqual(["Need Bun APIs"]);
		expect(response.answers.notes.answers).toEqual(["Ship in two phases"]);
	});
});

describe("summary helpers", () => {
	test("formats missing answer marker", () => {
		expect(summarizeRequestUserInputAnswer({ answers: [] })).toBe("(no answer)");
	});

	test("builds readable summary lines", () => {
		const details = {
			questions: [
				{ id: "runtime", header: "Runtime", question: "Which runtime?", options: [] },
			],
			response: {
				answers: {
					runtime: { answers: ["Bun for startup"] },
				},
			},
		};

		const summary = buildRequestUserInputSummary(details);
		expect(summary).toContain("1. Which runtime?");
		expect(summary).toContain("Bun for startup");
	});
});

describe("registerRequestUserInputTool", () => {
	test("emits waiting-for-user-input events while collecting answers", async () => {
		const emittedEvents: Array<{ channel: string; data: unknown }> = [];
		let registeredTool:
			| {
					execute: (toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: unknown, ctx?: any) => Promise<any>;
					promptSnippet?: string;
			  }
			| undefined;

		registerRequestUserInputTool(
			{
				registerTool: (tool: NonNullable<typeof registeredTool>) => {
					registeredTool = tool;
				},
				events: {
					emit: (channel: string, data: unknown) => {
						emittedEvents.push({ channel, data });
					},
				},
			} as any,
			{
				getState: () => ({ active: true }),
				requestUserInputSchema: {},
			},
		);

		if (!registeredTool) {
			throw new Error("request_user_input tool was not registered");
		}

		expect(registeredTool.promptSnippet).toBe(
			"Ask the user one to three short questions and wait for answers.",
		);

		const result = await registeredTool.execute(
			"call-1",
			{
				questions: [{ id: "runtime", question: "Which runtime?" }],
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: {
					custom: async () => ({
						responses: [
							{
								selectedOptionIndex: 0,
								customText: "Bun",
								selectionTouched: true,
								committed: true,
							},
						],
					}),
				},
			},
		);

		expect(result.isError).toBeUndefined();
		expect(emittedEvents).toEqual([
			{
				channel: "pi:waiting-for-user-input",
				data: {
					source: "plan-md:request_user_input",
					id: "call-1",
					waiting: true,
				},
			},
			{
				channel: "pi:waiting-for-user-input",
				data: {
					source: "plan-md:request_user_input",
					id: "call-1",
					waiting: false,
				},
			},
		]);
	});

	test("throws when plan mode is inactive", async () => {
		let execute:
			| ((toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: unknown, ctx?: any) => Promise<any>)
			| undefined;

		registerRequestUserInputTool(
			{
				registerTool: (tool: { execute: NonNullable<typeof execute> }) => {
					execute = tool.execute;
				},
				events: {
					emit() {},
				},
			} as any,
			{
				getState: () => ({ active: false }),
				requestUserInputSchema: {},
			},
		);

		if (!execute) {
			throw new Error("request_user_input tool was not registered");
		}

		let error: unknown;
		try {
			await execute(
				"call-1",
				{ questions: [{ id: "runtime", question: "Which runtime?" }] },
				undefined,
				undefined,
				{ hasUI: true, ui: { custom: async () => undefined } },
			);
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("inactive");
	});
});
