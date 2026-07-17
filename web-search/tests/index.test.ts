import { describe, expect, test } from "vitest";
import webSearchExtension from "../index";

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
});
