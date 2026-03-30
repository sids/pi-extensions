import { describe, expect, test } from "bun:test";
import type { AutocompleteItem, AutocompleteProvider } from "@mariozechner/pi-tui";
import {
	buildThinkingAutocompleteItems,
	createThinkingAutocompleteProvider,
	findThinkingTokenAtCursor,
	getAvailableThinkingLevels,
	normalizeThinkingLevel,
	stripThinkingLevelControlTokens,
} from "../utils";

type CompatibleAutocompleteProvider = AutocompleteProvider & {
	getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options?: { signal?: AbortSignal; force?: boolean },
	): any;
};

describe("normalizeThinkingLevel", () => {
	test("normalizes case-insensitively", () => {
		expect(normalizeThinkingLevel("HIGH")).toBe("high");
		expect(normalizeThinkingLevel(" xHiGh ")).toBe("xhigh");
	});

	test("returns null for unknown values", () => {
		expect(normalizeThinkingLevel("turbo")).toBeNull();
	});
});

describe("getAvailableThinkingLevels", () => {
	test("returns only off for non-reasoning models", () => {
		expect(getAvailableThinkingLevels({ id: "gpt-4.1", reasoning: false })).toEqual(["off"]);
	});

	test("returns off through high for reasoning models without xhigh", () => {
		expect(getAvailableThinkingLevels({ id: "claude-sonnet-4-5", reasoning: true })).toEqual([
			"off",
			"minimal",
			"low",
			"medium",
			"high",
		]);
	});

	test("includes xhigh for supported models", () => {
		expect(getAvailableThinkingLevels({ id: "gpt-5.3-codex", reasoning: true })).toEqual([
			"off",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
		]);
	});
});

describe("findThinkingTokenAtCursor", () => {
	test("detects ^ at start of line", () => {
		expect(findThinkingTokenAtCursor("^", 1)).toEqual({ token: "^", query: "" });
	});

	test("detects partial token at start of line", () => {
		expect(findThinkingTokenAtCursor("^me", 3)).toEqual({ token: "^me", query: "me" });
	});

	test("detects token after whitespace", () => {
		expect(findThinkingTokenAtCursor("use ^hi", 7)).toEqual({ token: "^hi", query: "hi" });
	});

	test("detects token in the middle of a line", () => {
		expect(findThinkingTokenAtCursor("please ^xh now", 10)).toEqual({ token: "^xh", query: "xh" });
	});

	test("returns null when cursor is outside token context", () => {
		expect(findThinkingTokenAtCursor("hello world", 5)).toBeNull();
	});

	test("returns null for embedded carets", () => {
		expect(findThinkingTokenAtCursor("abc^high", 8)).toBeNull();
	});

	test("returns null before the caret", () => {
		expect(findThinkingTokenAtCursor("^high", 0)).toBeNull();
	});

	test("detects token after tab", () => {
		expect(findThinkingTokenAtCursor("\t^lo", 4)).toEqual({ token: "^lo", query: "lo" });
	});
});

describe("stripThinkingLevelControlTokens", () => {
	test("strips token at the start of text", () => {
		expect(stripThinkingLevelControlTokens("^high summarize this")).toEqual({
			text: "summarize this",
			overrideLevel: "high",
			changed: true,
		});
	});

	test("strips token in the middle of text", () => {
		expect(stripThinkingLevelControlTokens("please ^low summarize this")).toEqual({
			text: "please summarize this",
			overrideLevel: "low",
			changed: true,
		});
	});

	test("strips token at the end of text", () => {
		expect(stripThinkingLevelControlTokens("summarize this ^minimal")).toEqual({
			text: "summarize this",
			overrideLevel: "minimal",
			changed: true,
		});
	});

	test("supports anywhere-token behavior across newlines", () => {
		expect(stripThinkingLevelControlTokens("please\n^high summarize")).toEqual({
			text: "please\nsummarize",
			overrideLevel: "high",
			changed: true,
		});
	});

	test("leaves unknown tokens unchanged", () => {
		expect(stripThinkingLevelControlTokens("please ^turbo summarize")).toEqual({
			text: "please ^turbo summarize",
			overrideLevel: null,
			changed: false,
		});
	});

	test("does not strip embedded carets", () => {
		expect(stripThinkingLevelControlTokens("abc^high def")).toEqual({
			text: "abc^high def",
			overrideLevel: null,
			changed: false,
		});
	});

	test("strips all recognized tokens while honoring the first one", () => {
		expect(stripThinkingLevelControlTokens("please ^high ^low summarize")).toEqual({
			text: "please summarize",
			overrideLevel: "high",
			changed: true,
		});
	});

	test("parses tokens case-insensitively", () => {
		expect(stripThinkingLevelControlTokens("please ^HIGH summarize")).toEqual({
			text: "please summarize",
			overrideLevel: "high",
			changed: true,
		});
	});
});

describe("buildThinkingAutocompleteItems", () => {
	test("builds items in thinking order and marks the current level", () => {
		expect(buildThinkingAutocompleteItems(["off", "low", "high"], "low")).toEqual([
			{ value: "off", label: "off", description: undefined },
			{ value: "low", label: "low", description: "current level" },
			{ value: "high", label: "high", description: undefined },
		]);
	});
});

describe("createThinkingAutocompleteProvider", () => {
	const thinkingItems: AutocompleteItem[] = [
		{ value: "off", label: "off" },
		{ value: "minimal", label: "minimal" },
		{ value: "low", label: "low" },
		{ value: "medium", label: "medium" },
		{ value: "high", label: "high", description: "current level" },
		{ value: "xhigh", label: "xhigh" },
	];

	const baseProvider: AutocompleteProvider = {
		getSuggestions(lines, cursorLine, cursorCol) {
			const line = lines[cursorLine] || "";
			const before = line.slice(0, cursorCol);
			if (before.startsWith("/")) {
				return { items: [{ value: "/help", label: "/help" }], prefix: before };
			}
			return null;
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			const line = lines[cursorLine] || "";
			const startCol = cursorCol - prefix.length;
			const newLine = line.slice(0, startCol) + item.value + line.slice(cursorCol);
			const newLines = [...lines];
			newLines[cursorLine] = newLine;
			return { lines: newLines, cursorLine, cursorCol: startCol + item.value.length };
		},
	};

	function makeProvider() {
		return createThinkingAutocompleteProvider(baseProvider, () => thinkingItems);
	}

	describe("getSuggestions", () => {
		test("returns all levels for bare caret", () => {
			const provider = makeProvider();
			const result = provider.getSuggestions(["^"], 0, 1);
			expect(result).not.toBeNull();
			expect(result!.items).toEqual(thinkingItems);
			expect(result!.prefix).toBe("^");
		});

		test("filters levels by partial query", () => {
			const provider = makeProvider();
			const result = provider.getSuggestions(["^xh"], 0, 3);
			expect(result).not.toBeNull();
			expect(result!.items).toEqual([{ value: "xhigh", label: "xhigh" }]);
			expect(result!.prefix).toBe("^xh");
		});

		test("returns null when no levels match", () => {
			const provider = makeProvider();
			expect(provider.getSuggestions(["^zzz"], 0, 4)).toBeNull();
		});

		test("delegates to base provider outside ^ context", () => {
			const provider = makeProvider();
			const result = provider.getSuggestions(["/he"], 0, 3);
			expect(result).not.toBeNull();
			expect(result!.items[0]!.value).toBe("/help");
		});

		test("forwards autocomplete options to async base providers", async () => {
			let seenOptions: { signal?: AbortSignal; force?: boolean } | undefined;
			const asyncBaseProvider: CompatibleAutocompleteProvider = {
				async getSuggestions(lines, cursorLine, cursorCol, options) {
					seenOptions = options;
					const line = lines[cursorLine] || "";
					const before = line.slice(0, cursorCol);
					if (before.startsWith("/")) {
						return { items: [{ value: "/help", label: "/help" }], prefix: before };
					}
					return null;
				},
				applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
					const line = lines[cursorLine] || "";
					const startCol = cursorCol - prefix.length;
					const newLine = line.slice(0, startCol) + item.value + line.slice(cursorCol);
					const newLines = [...lines];
					newLines[cursorLine] = newLine;
					return { lines: newLines, cursorLine, cursorCol: startCol + item.value.length };
				},
			};
			const provider = createThinkingAutocompleteProvider(asyncBaseProvider, () => thinkingItems) as CompatibleAutocompleteProvider;
			const controller = new AbortController();
			const result = await provider.getSuggestions(["/he"], 0, 3, {
				signal: controller.signal,
				force: true,
			});
			expect(result).not.toBeNull();
			expect(result!.items[0]!.value).toBe("/help");
			expect(seenOptions?.signal).toBe(controller.signal);
			expect(seenOptions?.force).toBe(true);
		});

		test("filters case-insensitively", () => {
			const provider = makeProvider();
			const result = provider.getSuggestions(["^HI"], 0, 3);
			expect(result).not.toBeNull();
			expect(result!.items).toEqual([{ value: "high", label: "high", description: "current level" }]);
		});

		test("does not trigger for embedded carets", () => {
			const provider = makeProvider();
			expect(provider.getSuggestions(["abc^hi"], 0, 6)).toBeNull();
		});
	});

	describe("applyCompletion", () => {
		test("replaces ^prefix with selected value", () => {
			const provider = makeProvider();
			const result = provider.applyCompletion(["^me"], 0, 3, thinkingItems[3]!, "^me");
			expect(result.lines).toEqual(["^medium"]);
			expect(result.cursorCol).toBe(7);
		});

		test("replaces in the middle of a line", () => {
			const provider = makeProvider();
			const result = provider.applyCompletion(["please ^lo now"], 0, 10, thinkingItems[2]!, "^lo");
			expect(result.lines).toEqual(["please ^low now"]);
			expect(result.cursorCol).toBe(11);
		});

		test("delegates to base for non-caret prefixes", () => {
			const provider = makeProvider();
			const result = provider.applyCompletion(["/he"], 0, 3, { value: "/help", label: "/help" }, "/he");
			expect(result.lines).toEqual(["/help"]);
		});
	});

	describe("optional method delegation", () => {
		test("delegates optional file-completion methods when present", () => {
			const extendedBase = {
				...baseProvider,
				getForceFileSuggestions() {
					return { items: [{ value: "file.ts", label: "file.ts" }], prefix: "" };
				},
				shouldTriggerFileCompletion() {
					return true;
				},
			};
			const provider = createThinkingAutocompleteProvider(extendedBase, () => thinkingItems) as Record<string, unknown>;
			expect(typeof provider.getForceFileSuggestions).toBe("function");
			expect(typeof provider.shouldTriggerFileCompletion).toBe("function");
		});
	});
});
