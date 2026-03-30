import { describe, expect, test } from "bun:test";
import webSearchExtension from "../index";

describe("web-search extension", () => {
	test("registers web_search with a prompt snippet", () => {
		let tool: { name: string; promptSnippet?: string } | undefined;

		webSearchExtension(
			{
				registerCommand() {},
				registerTool(candidate: { name: string; promptSnippet?: string }) {
					tool = candidate;
				},
			} as any,
		);

		expect(tool?.name).toBe("web_search");
		expect(tool?.promptSnippet).toBe("Search the web for titles, URLs, and result snippets.");
	});
});
