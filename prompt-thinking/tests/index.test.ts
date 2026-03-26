import { describe, expect, test } from "bun:test";
import type { AutocompleteProvider, EditorTheme, TUI } from "@mariozechner/pi-tui";
import { clearRememberedSessionEditorComponentFactory } from "@siddr/pi-shared-qna/session-editor-component";
import promptThinkingExtension, { PromptThinkingEditor } from "../index";
import type { ThinkingLevel } from "../utils";

type Handler = (event: any, ctx: any) => any;

let sessionCounter = 0;

function createHarness(initialThinkingLevel: ThinkingLevel = "high") {
	const handlers = new Map<string, Handler[]>();
	let currentThinkingLevel = initialThinkingLevel;
	let getThinkingCalls = 0;
	const setThinkingCalls: ThinkingLevel[] = [];
	const editorFactories: Array<(tui: TUI, theme: EditorTheme, keybindings: any) => PromptThinkingEditor> = [];

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

	function setEditorFactory(factory: (tui: TUI, theme: EditorTheme, keybindings: any) => PromptThinkingEditor) {
		editorFactories.push(factory);
	}

	return {
		emit,
		getThinkingLevel: () => currentThinkingLevel,
		getThinkingCallCount: () => getThinkingCalls,
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

function createUiSessionContext(model: { id: string; reasoning: boolean } = { id: "claude-sonnet-4-5", reasoning: true }) {
	const sessionFile = `/tmp/prompt-thinking-test-${++sessionCounter}.json`;
	let installedFactory: ((tui: TUI, theme: EditorTheme, keybindings: any) => PromptThinkingEditor) | undefined;
	return {
		sessionFile,
		getInstalledFactory: () => installedFactory,
		ctx: {
			hasUI: true,
			sessionManager: {
				getSessionFile: () => sessionFile,
			},
			model,
			ui: {
				setEditorComponent: (factory: typeof installedFactory) => {
					installedFactory = factory;
				},
			},
		},
	};
}

function cleanupSession(sessionFile: string) {
	clearRememberedSessionEditorComponentFactory({
		sessionManager: {
			getSessionFile: () => sessionFile,
		},
	});
}

describe("prompt-thinking extension", () => {
	test("installs a custom editor on session start", async () => {
		const harness = createHarness("high");
		const { ctx, getInstalledFactory, sessionFile } = createUiSessionContext();

		try {
			await harness.emit("session_start", {}, ctx);
			expect(typeof getInstalledFactory()).toBe("function");
		} finally {
			cleanupSession(sessionFile);
		}
	});

	test("installs a custom editor on session switch", async () => {
		const harness = createHarness("high");
		const { ctx, getInstalledFactory, sessionFile } = createUiSessionContext();

		try {
			await harness.emit("session_switch", {}, ctx);
			expect(typeof getInstalledFactory()).toBe("function");
		} finally {
			cleanupSession(sessionFile);
		}
	});

	test("reads the current thinking level when the dropdown opens", async () => {
		const harness = createHarness("high");
		const { ctx, getInstalledFactory, sessionFile } = createUiSessionContext();

		try {
			await harness.emit("session_start", {}, ctx);
			expect(harness.getThinkingCallCount()).toBe(0);

			const { tui, theme, keybindings } = createEditorTestDoubles();
			const editor = getInstalledFactory()!(tui, theme, keybindings);
			editor.setAutocompleteProvider(createEditorBaseProvider());
			harness.setThinkingLevelForTest("low");
			editor.handleInput("^");

			const selected = (editor as any).autocompleteList?.getSelectedItem();
			expect(selected?.value).toBe("low");
			expect(harness.getThinkingCallCount()).toBeGreaterThan(0);
		} finally {
			cleanupSession(sessionFile);
		}
	});

	test("refreshes available levels after model changes without reading the current level until dropdown open", async () => {
		const harness = createHarness("off");
		const { ctx, getInstalledFactory, sessionFile } = createUiSessionContext({ id: "gpt-4.1", reasoning: false });

		try {
			await harness.emit("session_start", {}, ctx);

			harness.setThinkingLevelForTest("xhigh");
			await harness.emit("model_select", { model: { id: "gpt-5.3-codex", reasoning: true } }, {});
			expect(harness.getThinkingCallCount()).toBe(0);

			const { tui, theme, keybindings } = createEditorTestDoubles();
			const editor = getInstalledFactory()!(tui, theme, keybindings);
			editor.setAutocompleteProvider(createEditorBaseProvider());
			editor.handleInput("^");

			const selected = (editor as any).autocompleteList?.getSelectedItem();
			expect(selected?.value).toBe("xhigh");
			expect(harness.getThinkingCallCount()).toBeGreaterThan(0);
		} finally {
			cleanupSession(sessionFile);
		}
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
