import { afterEach, describe, expect, test, vi } from "vitest";
import webSearchExtension from "../index";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("web-search extension", () => {
	test("registers Brave providers and web_search prompt metadata", () => {
		let tool: { name: string; promptSnippet?: string; promptGuidelines?: string[] } | undefined;
		const providers: Array<{ id: string; config: { name?: string; apiKey?: string } }> = [];

		webSearchExtension(
			{
				registerCommand() {},
				registerProvider(id: string, config: { name?: string; apiKey?: string }) {
					providers.push({ id, config });
				},
				registerTool(candidate: { name: string; promptSnippet?: string; promptGuidelines?: string[] }) {
					tool = candidate;
				},
			} as any,
		);

		expect(providers).toEqual([
			{
				id: "brave-search",
				config: { name: "Brave Search", apiKey: "$BRAVE_SEARCH_API_KEY" },
			},
			{
				id: "brave-search-fallback",
				config: {
					name: "Brave Search Fallback",
					apiKey: "$BRAVE_SEARCH_FALLBACK_API_KEY",
				},
			},
		]);
		expect(tool?.name).toBe("web_search");
		expect(tool?.promptSnippet).toBe("Search the web for titles, URLs, and result snippets.");
		expect(tool?.promptGuidelines).toEqual([
			"Use web_search when current or external information is needed and the user has not provided a specific URL.",
		]);
	});

	test("prefills the provider login command during setup", () => {
		let setup: ((args: string, ctx: any) => void) | undefined;
		const editorText: string[] = [];
		const notifications: string[] = [];

		webSearchExtension(
			{
				registerCommand(name: string, command: { handler: (args: string, ctx: any) => void }) {
					if (name === "web-search-setup") setup = command.handler;
				},
				registerProvider() {},
				registerTool() {},
			} as any,
		);

		setup?.("fallback", {
			hasUI: true,
			ui: {
				setEditorText(value: string) {
					editorText.push(value);
				},
				notify(message: string) {
					notifications.push(message);
				},
			},
		});

		expect(editorText).toEqual(["/login brave-search-fallback"]);
		expect(notifications).toEqual(["Press Enter to configure the Brave Search API key."]);
	});

	test("passes the tool abort signal to Brave requests", async () => {
		let tool: any;
		webSearchExtension(
			{
				registerCommand() {},
				registerProvider() {},
				registerTool(candidate: any) {
					tool = candidate;
				},
			} as any,
		);
		if (!tool) {
			throw new Error("web_search was not registered");
		}

		const controller = new AbortController();
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ web: { results: [] } }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);

		await tool.execute(
			"call-1",
			{ query: "pi extensions" },
			controller.signal,
			undefined,
			{
				modelRegistry: {
					getApiKeyForProvider: async (providerId: string) =>
						providerId === "brave-search" ? "api-key" : undefined,
				},
			},
		);

		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.search.brave.com/res/v1/web/search?q=pi+extensions&count=10",
			expect.objectContaining({ signal: controller.signal }),
		);
	});
});
