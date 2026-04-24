import { describe, expect, test } from "bun:test";
import type { AutocompleteProvider } from "@mariozechner/pi-tui";
import promptThinkingExtension from "../index";
import type { ThinkingLevel } from "../utils";

type Handler = (event: any, ctx: any) => any;

function createHarness(initialThinkingLevel: ThinkingLevel = "high") {
	const handlers = new Map<string, Handler[]>();
	const providerFactories: Array<(current: AutocompleteProvider) => AutocompleteProvider> = [];
	let currentThinkingLevel = initialThinkingLevel;
	let getThinkingCalls = 0;
	const setThinkingCalls: ThinkingLevel[] = [];

	const pi = {
		on(name: string, handler: Handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		getThinkingLevel() {
			getThinkingCalls += 1;
			return currentThinkingLevel;
		},
		setThinkingLevel(level: ThinkingLevel) {
			currentThinkingLevel = level;
			setThinkingCalls.push(level);
		},
	} as any;

	promptThinkingExtension(pi);

	async function emit(name: string, event: any = {}, ctx: any = {}) {
		const list = handlers.get(name) ?? [];
		let result;
		for (const handler of list) {
			result = await handler(event, ctx);
		}
		return result;
	}

	function createSessionContext(model: { id: string; reasoning: boolean } = { id: "claude-sonnet-4-5", reasoning: true }) {
		return {
			hasUI: true,
			model,
			ui: {
				addAutocompleteProvider(factory: (current: AutocompleteProvider) => AutocompleteProvider) {
					providerFactories.push(factory);
				},
			},
		};
	}

	return {
		emit,
		providerFactories,
		createSessionContext,
		getThinkingLevel: () => currentThinkingLevel,
		getThinkingCallCount: () => getThinkingCalls,
		setThinkingLevelForTest: (level: ThinkingLevel) => {
			currentThinkingLevel = level;
		},
		setThinkingCalls,
	};
}

function createBaseProvider(): AutocompleteProvider {
	return {
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
}

function composeProviders(factories: Array<(current: AutocompleteProvider) => AutocompleteProvider>): AutocompleteProvider {
	let current = createBaseProvider();
	for (const factory of factories) {
		current = factory(current);
	}
	return current;
}

describe("prompt-thinking extension", () => {
	test("registers an autocomplete provider on session start", async () => {
		const harness = createHarness("high");

		await harness.emit("session_start", {}, harness.createSessionContext());
		expect(harness.providerFactories).toHaveLength(1);
	});

	test("registers an autocomplete provider when session_start fires for resume", async () => {
		const harness = createHarness("high");

		await harness.emit("session_start", { reason: "resume" }, harness.createSessionContext());
		expect(harness.providerFactories).toHaveLength(1);
	});

	test("reads the current thinking level when suggestions are requested", async () => {
		const harness = createHarness("high");
		await harness.emit("session_start", {}, harness.createSessionContext());
		expect(harness.getThinkingCallCount()).toBe(0);

		harness.setThinkingLevelForTest("low");
		const provider = composeProviders(harness.providerFactories);
		const result = provider.getSuggestions(["^"], 0, 1);

		expect(result?.items[0]?.value).toBe("low");
		expect(harness.getThinkingCallCount()).toBeGreaterThan(0);
	});

	test("refreshes available levels after model changes without reading the current level until suggestions", async () => {
		const harness = createHarness("off");
		await harness.emit("session_start", {}, harness.createSessionContext({ id: "gpt-4.1", reasoning: false }));

		harness.setThinkingLevelForTest("xhigh");
		await harness.emit("model_select", { model: { id: "gpt-5.3-codex", reasoning: true } }, {});
		expect(harness.getThinkingCallCount()).toBe(0);

		const provider = composeProviders(harness.providerFactories);
		const result = provider.getSuggestions(["^"], 0, 1);
		expect(result?.items[0]?.value).toBe("xhigh");
		expect(harness.getThinkingCallCount()).toBeGreaterThan(0);
	});

	test("transforms prompts with ^thinking tokens and restores the previous level after the prompt", async () => {
		const harness = createHarness("high");
		const inputResult = await harness.emit(
			"input",
			{ text: "please ^low summarize", images: ["img"], source: "interactive" },
			{},
		);

		expect(inputResult).toEqual({
			action: "transform",
			text: "please summarize",
			images: ["img"],
		});

		await harness.emit("before_agent_start", { prompt: "please summarize" }, {});
		expect(harness.setThinkingCalls).toEqual(["low"]);
		expect(harness.getThinkingLevel()).toBe("low");

		await harness.emit("agent_end", {}, {});
		expect(harness.setThinkingCalls).toEqual(["low", "high"]);
		expect(harness.getThinkingLevel()).toBe("high");
	});

	test("queues plain prompts without changing thinking level", async () => {
		const harness = createHarness("high");
		const inputResult = await harness.emit(
			"input",
			{ text: "plain prompt", images: [], source: "interactive" },
			{},
		);

		expect(inputResult).toEqual({ action: "continue" });

		await harness.emit("before_agent_start", { prompt: "plain prompt" }, {});
		await harness.emit("agent_end", {}, {});
		expect(harness.setThinkingCalls).toEqual([]);
	});

	test("matches queued prompts by transformed text and ignores stale earlier entries", async () => {
		const harness = createHarness("high");

		await harness.emit("input", { text: "stale plain prompt", images: [], source: "interactive" }, {});
		const inputResult = await harness.emit(
			"input",
			{ text: "^minimal actual prompt", images: [], source: "interactive" },
			{},
		);

		expect(inputResult).toEqual({
			action: "transform",
			text: "actual prompt",
			images: [],
		});

		await harness.emit("before_agent_start", { prompt: "actual prompt" }, {});
		expect(harness.setThinkingCalls).toEqual(["minimal"]);
	});

	test("ignores extension-originated messages", async () => {
		const harness = createHarness("high");
		const inputResult = await harness.emit(
			"input",
			{ text: "^low summarize", images: [], source: "extension" },
			{},
		);

		expect(inputResult).toEqual({ action: "continue" });

		await harness.emit("before_agent_start", { prompt: "summarize" }, {});
		expect(harness.setThinkingCalls).toEqual([]);
	});

	test("clears queued state when session_start fires for resume", async () => {
		const harness = createHarness("high");
		await harness.emit("input", { text: "^low summarize", images: [], source: "interactive" }, {});

		await harness.emit(
			"session_start",
			{ reason: "resume" },
			{
				hasUI: false,
				model: { id: "claude-sonnet-4-5", reasoning: true },
				ui: {
					addAutocompleteProvider: () => {},
				},
			},
		);

		await harness.emit("before_agent_start", { prompt: "summarize" }, {});
		expect(harness.setThinkingCalls).toEqual([]);
	});
});
