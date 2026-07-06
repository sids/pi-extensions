import { describe, expect, test } from "vitest";
import fetchUrlExtension from "../index";

describe("fetch-url extension", () => {
	test("registers fetch_url with a prompt snippet", () => {
		let tool: { name: string; promptSnippet?: string; promptGuidelines?: string[] } | undefined;

		fetchUrlExtension(
			{
				registerTool(candidate: { name: string; promptSnippet?: string; promptGuidelines?: string[] }) {
					tool = candidate;
				},
			} as any,
		);

		expect(tool?.name).toBe("fetch_url");
		expect(tool?.promptSnippet).toBe(
			"Fetch a URL and return extracted markdown, HTML, or raw content.",
		);
		expect(tool?.promptGuidelines).toEqual([
			"Use fetch_url when the user asks to inspect a URL or when web content is needed from a known URL.",
		]);
	});
});
