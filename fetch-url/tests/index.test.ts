import { afterEach, describe, expect, test, vi } from "vitest";
import fetchUrlExtension from "../index";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("fetch-url extension", () => {
	test("registers fetch_url with a prompt snippet", () => {
		let tool: { name: string; promptSnippet?: string; promptGuidelines?: string[]; constrainedSampling?: unknown } | undefined;

		fetchUrlExtension(
			{
				registerTool(candidate: { name: string; promptSnippet?: string; promptGuidelines?: string[]; constrainedSampling?: unknown }) {
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
		expect(tool?.constrainedSampling).toBe(false);
	});

	test("passes the tool abort signal to fetch", async () => {
		let tool: any;
		fetchUrlExtension(
			{
				registerTool(candidate: any) {
					tool = candidate;
				},
			} as any,
		);
		if (!tool) {
			throw new Error("fetch_url was not registered");
		}

		const controller = new AbortController();
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("response body", {
				status: 200,
				headers: { "content-type": "text/plain" },
			}),
		);

		await tool.execute("call-1", { url: "https://example.com/article" }, controller.signal);

		expect(fetchMock).toHaveBeenCalledWith(
			"https://example.com/article",
			expect.objectContaining({ signal: controller.signal }),
		);
	});
});
