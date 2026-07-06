import { describe, expect, test } from "vitest";
import webSearchExtension from "../index";

describe("web-search extension", () => {
	test("registers web_search with a prompt snippet", () => {
		let tool: { name: string; promptSnippet?: string; promptGuidelines?: string[] } | undefined;

		webSearchExtension(
			{
				registerCommand() {},
				registerTool(candidate: { name: string; promptSnippet?: string; promptGuidelines?: string[] }) {
					tool = candidate;
				},
			} as any,
		);

		expect(tool?.name).toBe("web_search");
		expect(tool?.promptSnippet).toBe("Search the web for titles, URLs, and result snippets.");
		expect(tool?.promptGuidelines).toEqual([
			"Use web_search when current or external information is needed and the user has not provided a specific URL.",
		]);
	});
});
