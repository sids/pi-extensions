import { describe, expect, test } from "bun:test";
import fetchUrlExtension from "../index";

describe("fetch-url extension", () => {
	test("registers fetch_url with a prompt snippet", () => {
		let tool: { name: string; promptSnippet?: string } | undefined;

		fetchUrlExtension(
			{
				registerTool(candidate: { name: string; promptSnippet?: string }) {
					tool = candidate;
				},
			} as any,
		);

		expect(tool?.name).toBe("fetch_url");
		expect(tool?.promptSnippet).toBe(
			"Fetch a URL and return extracted markdown, HTML, or raw content.",
		);
	});
});
