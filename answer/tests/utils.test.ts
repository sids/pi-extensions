import { describe, expect, test } from "bun:test";
import {
	applyTemplate,
	mergeAnswerSettings,
	normalizeTemplates,
	parseExtractionResult,
} from "../utils";

describe("parseExtractionResult", () => {
	test("extracts JSON from code blocks", () => {
		const input = "```json\n{\n  \"questions\": [{ \"question\": \"Ready?\" }]\n}\n```";
		const result = parseExtractionResult(input);
		expect(result?.questions[0]?.question).toBe("Ready?");
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
