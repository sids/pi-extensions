import { describe, expect, test } from "bun:test";
import {
	applyTemplate,
	mergeAnswerSettings,
	normalizeTemplates,
	parseExtractionResult,
	questionsMatch,
	resolveNumericOptionShortcut,
} from "../utils";
import { formatResponseAnswer, normalizeResponses } from "../../shared/qna-tui";

describe("parseExtractionResult", () => {
	test("extracts JSON from code blocks", () => {
		const input = "```json\n{\n  \"questions\": [{ \"question\": \"Ready?\" }]\n}\n```";
		const result = parseExtractionResult(input);
		expect(result?.questions[0]?.question).toBe("Ready?");
		expect(result?.questions[0]?.id).toBe("ready");
	});

	test("normalizes ids/options and leaves header optional", () => {
		const input = JSON.stringify({
			questions: [
				{
					question: "Should we ship now?",
					options: [
						{ label: "Yes", description: "Release this week." },
						{ label: "No" },
					],
				},
			],
		});

		const result = parseExtractionResult(input);
		expect(result?.questions[0]).toEqual({
			id: "should_we_ship_now",
			question: "Should we ship now?",
			options: [
				{ label: "Yes", description: "Release this week." },
				{ label: "No", description: "" },
			],
		});
	});

	test("returns null for invalid JSON", () => {
		const result = parseExtractionResult("not json");
		expect(result).toBeNull();
	});
});

describe("applyTemplate", () => {
	test("replaces placeholders", () => {
		const template = "Q: {{question}}\nA: {{answer}}\nContext: {{context}}\n{{index}}/{{total}}";
		const output = applyTemplate(template, {
			question: "Ship it?",
			context: "CI is green",
			answer: "Yes",
			index: 1,
			total: 3,
		});

		expect(output).toBe("Q: Ship it?\nA: Yes\nContext: CI is green\n2/3");
	});
});

describe("normalizeTemplates", () => {
	test("builds labels for mixed templates", () => {
		const templates = normalizeTemplates([
			"Use bullet points",
			{ label: "Short", template: "Be brief" },
		]);

		expect(templates).toEqual([
			{ label: "Template 1", template: "Use bullet points" },
			{ label: "Short", template: "Be brief" },
		]);
	});
});

describe("mergeAnswerSettings", () => {
	test("project overrides global drafts settings", () => {
		const merged = mergeAnswerSettings(
			{ drafts: { enabled: false, autosaveMs: 500 } },
			{ drafts: { promptOnRestore: false } },
		);

		expect(merged.drafts?.enabled).toBe(false);
		expect(merged.drafts?.autosaveMs).toBe(500);
		expect(merged.drafts?.promptOnRestore).toBe(false);
	});
});

describe("questionsMatch", () => {
	test("allows non-semantic metadata drift", () => {
		const left = [
			{
				id: "runtime",
				header: "Runtime",
				question: "What runtime?",
				context: "Current service runs with Bun",
				options: [
					{ label: "Node", description: "Use Node.js" },
					{ label: "Bun", description: "Use Bun" },
				],
			},
		];
		const right = [
			{
				id: "runtime",
				header: "JS runtime",
				question: "Which runtime should we use?",
				context: "Current deployment uses Bun",
				options: [
					{ label: "Node", description: "Node.js for compatibility" },
					{ label: "Bun", description: "Bun for speed" },
				],
			},
		];

		expect(questionsMatch(left, right)).toBe(true);
		expect(
			questionsMatch(
				[{ id: "runtime_choice", question: "What runtime?" }],
				[{ id: "js_runtime", question: "What runtime?" }],
			),
		).toBe(true);
	});

	test("still requires option shape compatibility", () => {
		const left = [
			{
				id: "runtime",
				question: "What runtime?",
				options: [
					{ label: "Node", description: "Use Node.js" },
					{ label: "Bun", description: "Use Bun" },
				],
			},
		];

		expect(
			questionsMatch(left, [
				{
					id: "runtime",
					question: "What runtime?",
					options: [{ label: "Node", description: "Use Node.js" }],
				},
			]),
		).toBe(false);

		expect(
			questionsMatch(left, [
				{
					id: "runtime",
					question: "What runtime?",
					options: [
						{ label: "Node", description: "Use Node.js" },
						{ label: "Deno", description: "Use Deno" },
					],
				},
			]),
		).toBe(false);
	});
});

describe("resolveNumericOptionShortcut", () => {
	test("returns selected index in option mode", () => {
		expect(resolveNumericOptionShortcut("1", 3, false)).toBe(0);
		expect(resolveNumericOptionShortcut("4", 3, false)).toBe(3);
	});

	test("does not capture numeric input while editing custom answer", () => {
		expect(resolveNumericOptionShortcut("1", 3, true)).toBeNull();
		expect(resolveNumericOptionShortcut("9", 3, true)).toBeNull();
	});

	test("ignores invalid shortcut inputs", () => {
		expect(resolveNumericOptionShortcut("0", 3, false)).toBeNull();
		expect(resolveNumericOptionShortcut("x", 3, false)).toBeNull();
		expect(resolveNumericOptionShortcut("9", 3, false)).toBeNull();
	});
});

describe("shared qna helpers", () => {
	test("normalizes fallback answers into option selection", () => {
		const questions = [
			{
				question: "Preferred runtime?",
				options: [
					{ label: "Node", description: "Use Node.js" },
					{ label: "Bun", description: "Use Bun" },
				],
			},
		];

		const responses = normalizeResponses(questions, undefined, ["Bun"], false);
		expect(formatResponseAnswer(questions[0], responses[0])).toBe("Bun");
	});

	test("treats non-option fallback as custom answer", () => {
		const questions = [
			{
				question: "Notes",
				options: [{ label: "No", description: "Skip" }],
			},
		];

		const responses = normalizeResponses(questions, undefined, ["Need more context"], false);
		expect(formatResponseAnswer(questions[0], responses[0])).toBe("Need more context");
	});
});
