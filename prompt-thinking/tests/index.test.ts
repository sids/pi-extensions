import { describe, expect, test } from "bun:test";
import type { AutocompleteProvider, EditorTheme, TUI } from "@mariozechner/pi-tui";
import promptThinkingExtension, { PromptThinkingEditor } from "../index";
import type { ThinkingLevel } from "../utils";

type Handler = (event: any, ctx: any) => any;

function createHarness(initialThinkingLevel: ThinkingLevel = "high") {
	const handlers = new Map<string, Handler[]>();
	let currentThinkingLevel = initialThinkingLevel;
	const setThinkingCalls: ThinkingLevel[] = [];
	const editorFactories: Array<(tui: TUI, theme: EditorTheme, keybindings: any) => PromptThinkingEditor> = [];

	const pi = {
		on(name: string, handler: Handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		getThinkingLevel() {
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

	function setEditorFactory(factory: (tui: TUI, theme: EditorTheme, keybindings: any) => PromptThinkingEditor) {
		editorFactories.push(factory);
	}

	return {
		emit,
		getThinkingLevel: () => currentThinkingLevel,
		setThinkingLevelForTest: (level: ThinkingLevel) => {
			currentThinkingLevel = level;
		},
		setThinkingCalls,
		editorFactories,
		setEditorFactory,
	};
}

function createEditorBaseProvider(): AutocompleteProvider {
	return {
		getSuggestions() {
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

function createEditorTestDoubles() {
	const tui = {
		requestRender() {},
	} as unknown as TUI;

	const theme = {
		borderColor: (text: string) => text,
		selectList: {
			selectedPrefix: (text: string) => text,
			selectedText: (text: string) => text,
			description: (text: string) => text,
			scrollInfo: (text: string) => text,
			noMatch: (text: string) => text,
		},
	} as unknown as EditorTheme;

	const keybindings = {
		matches() {
			return false;
		},
	};

	return { tui, theme, keybindings };
}

describe("prompt-thinking extension", () => {
	test("installs a custom editor on session start", async () => {
		const harness = createHarness("high");
		let installedFactory: ((tui: TUI, theme: EditorTheme, keybindings: any) => PromptThinkingEditor) | undefined;

		await harness.emit(
			"session_start",
			{},
			{
				hasUI: true,
				model: { id: "claude-sonnet-4-5", reasoning: true },
				ui: {
					setEditorComponent: (factory: typeof installedFactory) => {
						installedFactory = factory;
					},
				},
			},
		);

		expect(typeof installedFactory).toBe("function");
	});

	test("installs a custom editor on session switch", async () => {
		const harness = createHarness("high");
		let installedFactory: ((tui: TUI, theme: EditorTheme, keybindings: any) => PromptThinkingEditor) | undefined;

		await harness.emit(
			"session_switch",
			{},
			{
				hasUI: true,
				model: { id: "claude-sonnet-4-5", reasoning: true },
				ui: {
					setEditorComponent: (factory: typeof installedFactory) => {
						installedFactory = factory;
					},
				},
			},
		);

		expect(typeof installedFactory).toBe("function");
	});

	test("preselects the current thinking level in autocomplete", async () => {
		const harness = createHarness("high");
		let installedFactory: ((tui: TUI, theme: EditorTheme, keybindings: any) => PromptThinkingEditor) | undefined;

		await harness.emit(
			"session_start",
			{},
			{
				hasUI: true,
				model: { id: "claude-sonnet-4-5", reasoning: true },
				ui: {
					setEditorComponent: (factory: typeof installedFactory) => {
						installedFactory = factory;
					},
				},
			},
		);

		const { tui, theme, keybindings } = createEditorTestDoubles();
		const editor = installedFactory!(tui, theme, keybindings);
		editor.setAutocompleteProvider(createEditorBaseProvider());
		editor.handleInput("^");

		const selected = (editor as any).autocompleteList?.getSelectedItem();
		expect(selected?.value).toBe("high");
	});

	test("refreshes available levels after model changes", async () => {
		const harness = createHarness("off");
		let installedFactory: ((tui: TUI, theme: EditorTheme, keybindings: any) => PromptThinkingEditor) | undefined;

		await harness.emit(
			"session_start",
			{},
			{
				hasUI: true,
				model: { id: "gpt-4.1", reasoning: false },
				ui: {
					setEditorComponent: (factory: typeof installedFactory) => {
						installedFactory = factory;
					},
				},
			},
		);

		harness.setThinkingLevelForTest("xhigh");
		await harness.emit("model_select", { model: { id: "gpt-5.3-codex", reasoning: true } }, {});

		const { tui, theme, keybindings } = createEditorTestDoubles();
		const editor = installedFactory!(tui, theme, keybindings);
		editor.setAutocompleteProvider(createEditorBaseProvider());
		editor.handleInput("^");

		const selected = (editor as any).autocompleteList?.getSelectedItem();
		expect(selected?.value).toBe("xhigh");
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

	test("clears queued state on session switch", async () => {
		const harness = createHarness("high");
		await harness.emit("input", { text: "^low summarize", images: [], source: "interactive" }, {});

		await harness.emit(
			"session_switch",
			{},
			{
				hasUI: false,
				model: { id: "claude-sonnet-4-5", reasoning: true },
				ui: {
					setEditorComponent: () => {},
				},
			},
		);

		await harness.emit("before_agent_start", { prompt: "summarize" }, {});
		expect(harness.setThinkingCalls).toEqual([]);
	});
});
