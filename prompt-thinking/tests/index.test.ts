import { describe, expect, test, vi } from "vitest";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import promptThinkingExtension from "../index";
import type { ThinkingLevel } from "../utils";

type Handler = (event: any, ctx: any) => any;
type ShortcutHandler = (ctx: any) => any;
type TestModel = {
	id: string;
	reasoning: boolean;
	thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
};

function createHarness(initialThinkingLevel: ThinkingLevel = "high") {
	const handlers = new Map<string, Handler[]>();
	const providerFactories: Array<(current: AutocompleteProvider) => AutocompleteProvider> = [];
	const shortcuts = new Map<string, { description: string; handler: ShortcutHandler }>();
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
		registerShortcut(shortcut: string, options: { description: string; handler: ShortcutHandler }) {
			shortcuts.set(shortcut, options);
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

	function createSessionContext(
		model: TestModel = {
			id: "claude-sonnet-4-5",
			reasoning: true,
		},
	) {
		return {
			hasUI: true,
			model,
			ui: {
				notify: vi.fn(),
				custom: vi.fn(async (): Promise<ThinkingLevel | null> => null),
				addAutocompleteProvider(factory: (current: AutocompleteProvider) => AutocompleteProvider) {
					providerFactories.push(factory);
				},
			},
		};
	}

	return {
		emit,
		providerFactories,
		shortcuts,
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

function driveThinkingSelector(inputs: string[]) {
	return async (factory: any): Promise<ThinkingLevel | null> => {
		let selection: ThinkingLevel | null = null;
		const component = factory(
			{ requestRender: vi.fn() },
			undefined,
			undefined,
			(value: ThinkingLevel | null) => {
				selection = value;
			},
		);
		for (const input of inputs) {
			component.handleInput(input);
		}
		return selection;
	};
}

describe("prompt-thinking extension", () => {
	test("registers Alt+Shift+Tab and cycles to the previous supported level", () => {
		const harness = createHarness("high");
		const ctx = harness.createSessionContext({
			id: "reasoning-model",
			reasoning: true,
			thinkingLevelMap: { minimal: null, medium: null, xhigh: null },
		});
		const shortcut = harness.shortcuts.get("alt+shift+tab");

		expect(shortcut?.description).toBe("Cycle thinking level backward");
		shortcut?.handler(ctx);

		expect(harness.setThinkingCalls).toEqual(["low"]);
		expect(ctx.ui.notify).toHaveBeenCalledWith("Thinking level: low", "info");
	});

	test("the thinking shortcut wraps to the highest supported level", () => {
		const harness = createHarness("off");
		const ctx = harness.createSessionContext({
			id: "reasoning-model",
			reasoning: true,
			thinkingLevelMap: {
				minimal: null,
				low: null,
				medium: null,
				xhigh: null,
				max: "max",
			},
		});

		harness.shortcuts.get("alt+shift+tab")?.handler(ctx);

		expect(harness.setThinkingCalls).toEqual(["max"]);
	});

	test("the thinking shortcut leaves non-reasoning models unchanged", () => {
		const harness = createHarness("off");
		const ctx = harness.createSessionContext({ id: "plain-model", reasoning: false });

		harness.shortcuts.get("alt+shift+tab")?.handler(ctx);

		expect(harness.setThinkingCalls).toEqual([]);
		expect(ctx.ui.notify).toHaveBeenCalledWith("Current model does not support thinking", "info");
	});

	test("the thinking shortcut updates the session level without changing an active prompt override", async () => {
		const harness = createHarness("high");
		const ctx = harness.createSessionContext();
		await harness.emit("input", { text: "^low summarize", images: [], source: "interactive" }, {});
		await harness.emit("before_agent_start", { prompt: "summarize" }, {});

		harness.shortcuts.get("alt+shift+tab")?.handler(ctx);

		expect(harness.getThinkingLevel()).toBe("low");
		expect(harness.setThinkingCalls).toEqual(["low"]);
		expect(ctx.ui.notify).toHaveBeenCalledWith("Thinking level: medium", "info");

		await harness.emit("agent_end", {}, {});
		expect(harness.getThinkingLevel()).toBe("medium");
		expect(harness.setThinkingCalls).toEqual(["low", "medium"]);
	});

	test("Ctrl+Shift+T selects from the supported thinking levels", async () => {
		const harness = createHarness("high");
		const ctx = harness.createSessionContext({
			id: "reasoning-model",
			reasoning: true,
			thinkingLevelMap: { minimal: null, xhigh: "xhigh" },
		});
		ctx.ui.custom.mockImplementation(driveThinkingSelector(["\x1b[A", "\x1b[A", "\r"]));
		const shortcut = harness.shortcuts.get("ctrl+shift+t");

		expect(shortcut?.description).toBe("Select thinking level");
		await shortcut?.handler(ctx);

		expect(ctx.ui.custom).toHaveBeenCalledOnce();
		expect(harness.setThinkingCalls).toEqual(["low"]);
		expect(ctx.ui.notify).toHaveBeenCalledWith("Thinking level: low", "info");
	});

	test("the thinking selector filters levels as the user types", async () => {
		const harness = createHarness("high");
		const ctx = harness.createSessionContext();
		ctx.ui.custom.mockImplementation(driveThinkingSelector(["l", "\r"]));

		await harness.shortcuts.get("ctrl+shift+t")?.handler(ctx);

		expect(harness.setThinkingCalls).toEqual(["low"]);
		expect(ctx.ui.notify).toHaveBeenCalledWith("Thinking level: low", "info");
	});

	test("the thinking selector updates the session level without changing an active prompt override", async () => {
		const harness = createHarness("high");
		const ctx = harness.createSessionContext();
		ctx.ui.custom.mockResolvedValue("medium");
		await harness.emit("input", { text: "^low summarize", images: [], source: "interactive" }, {});
		await harness.emit("before_agent_start", { prompt: "summarize" }, {});

		await harness.shortcuts.get("ctrl+shift+t")?.handler(ctx);

		expect(harness.getThinkingLevel()).toBe("low");
		expect(harness.setThinkingCalls).toEqual(["low"]);
		expect(ctx.ui.custom).toHaveBeenCalledOnce();

		await harness.emit("agent_end", {}, {});
		expect(harness.getThinkingLevel()).toBe("medium");
		expect(harness.setThinkingCalls).toEqual(["low", "medium"]);
	});

	test("the thinking selector clamps a saved session level after the model changes", async () => {
		const harness = createHarness("max");
		const ctx = harness.createSessionContext();
		ctx.ui.custom.mockImplementation(driveThinkingSelector(["\r"]));
		await harness.emit("input", { text: "^low summarize", images: [], source: "interactive" }, {});
		await harness.emit("before_agent_start", { prompt: "summarize" }, {});

		await harness.shortcuts.get("ctrl+shift+t")?.handler(ctx);

		expect(harness.getThinkingLevel()).toBe("low");
		expect(harness.setThinkingCalls).toEqual(["low"]);
		expect(ctx.ui.notify).toHaveBeenCalledWith("Thinking level: high", "info");

		await harness.emit("agent_end", {}, {});
		expect(harness.getThinkingLevel()).toBe("high");
		expect(harness.setThinkingCalls).toEqual(["low", "high"]);
	});

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

	test("reads available levels from the live model when suggestions are requested", async () => {
		const harness = createHarness("off");
		const ctx = harness.createSessionContext({ id: "plain-model", reasoning: false });
		await harness.emit("session_start", {}, ctx);

		harness.setThinkingLevelForTest("xhigh");
		ctx.model = {
			id: "reasoning-model",
			reasoning: true,
			thinkingLevelMap: { xhigh: "xhigh" },
		};
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
