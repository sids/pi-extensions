import { describe, expect, test } from "bun:test";
import type { AutocompleteProvider, EditorTheme, TUI } from "@mariozechner/pi-tui";
import { clearRememberedSessionEditorComponentFactory } from "@siddr/pi-shared-qna/session-editor-component";
import mentionSkillsExtension from "../index";
import promptThinkingExtension from "../../prompt-thinking/index";

function createCommand(name: string, source: "extension" | "prompt" | "skill", path?: string) {
	return {
		name,
		source,
		sourceInfo: {
			path: path ?? `<${source}:${name}>`,
			source,
			scope: "temporary",
			origin: "top-level",
		},
	};
}

type Handler = (event: any, ctx: any) => any;
type ExtensionName = "mention" | "thinking";

let sessionCounter = 0;

function createHarness(commands: any[], extensionOrder: ExtensionName[] = ["mention"]) {
	const handlers = new Map<string, Handler[]>();
	let currentThinkingLevel = "low";

	const pi = {
		on(name: string, handler: Handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		getCommands() {
			return commands;
		},
		getThinkingLevel() {
			return currentThinkingLevel;
		},
		setThinkingLevel(level: string) {
			currentThinkingLevel = level;
		},
	} as any;

	for (const extensionName of extensionOrder) {
		if (extensionName === "mention") {
			mentionSkillsExtension(pi);
			continue;
		}
		promptThinkingExtension(pi);
	}

	return {
		async emit(name: string, event: any = {}, ctx: any = {}) {
			const list = handlers.get(name) ?? [];
			let result;
			for (const handler of list) {
				result = await handler(event, ctx);
			}
			return result;
		},
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

function createUiSessionContext() {
	const sessionFile = `/tmp/mention-skills-test-${++sessionCounter}.json`;
	let installedFactory: ((...args: any[]) => any) | undefined;
	return {
		sessionFile,
		getInstalledFactory: () => installedFactory,
		ctx: {
			hasUI: true,
			sessionManager: {
				getSessionFile: () => sessionFile,
			},
			model: { id: "claude-sonnet-4-5", reasoning: true },
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

describe("mention-skills extension", () => {
	test("installs a custom editor on session start", async () => {
		const harness = createHarness([createCommand("skill:commit", "skill", "/skills/commit/SKILL.md")]);
		const { ctx, getInstalledFactory, sessionFile } = createUiSessionContext();

		try {
			await harness.emit("session_start", {}, ctx);
			expect(typeof getInstalledFactory()).toBe("function");
		} finally {
			cleanupSession(sessionFile);
		}
	});

	test("transforms skill mentions using discovered skills", async () => {
		const harness = createHarness([
			createCommand("skill:commit", "skill", "/skills/commit/SKILL.md"),
			createCommand("skill:pdf", "skill", "/skills/pdf/SKILL.md"),
		]);

		await harness.emit("resources_discover");

		const result = await harness.emit(
			"input",
			{ text: "Use $commit and $pdf", images: [], source: "interactive" },
			{},
		);

		expect(result).toEqual({
			action: "transform",
			text: "Use /skills/commit/SKILL.md and /skills/pdf/SKILL.md",
			images: [],
		});
	});

	test("keeps $ and ^ autocomplete when prompt-thinking installs after mention-skills", async () => {
		const harness = createHarness(
			[createCommand("skill:commit", "skill", "/skills/commit/SKILL.md")],
			["mention", "thinking"],
		);
		const { ctx, getInstalledFactory, sessionFile } = createUiSessionContext();

		try {
			await harness.emit("session_start", {}, ctx);
			const installedFactory = getInstalledFactory();
			expect(typeof installedFactory).toBe("function");

			const { tui, theme, keybindings } = createEditorTestDoubles();
			const createEditor = () => {
				const editor = installedFactory!(tui, theme, keybindings);
				editor.setAutocompleteProvider(createEditorBaseProvider());
				return editor;
			};

			const mentionEditor = createEditor();
			mentionEditor.handleInput("$");
			expect(mentionEditor.isShowingAutocomplete()).toBe(true);
			expect((mentionEditor as any).autocompleteList?.getSelectedItem?.()?.value).toBe("$commit");

			const thinkingEditor = createEditor();
			thinkingEditor.handleInput("^");
			expect(thinkingEditor.isShowingAutocomplete()).toBe(true);
			expect((thinkingEditor as any).autocompleteList?.getSelectedItem?.()?.value).toBe("low");
		} finally {
			cleanupSession(sessionFile);
		}
	});

	test("keeps $ and ^ autocomplete when mention-skills installs after prompt-thinking", async () => {
		const harness = createHarness(
			[createCommand("skill:commit", "skill", "/skills/commit/SKILL.md")],
			["thinking", "mention"],
		);
		const { ctx, getInstalledFactory, sessionFile } = createUiSessionContext();

		try {
			await harness.emit("session_start", {}, ctx);
			const installedFactory = getInstalledFactory();
			expect(typeof installedFactory).toBe("function");

			const { tui, theme, keybindings } = createEditorTestDoubles();
			const createEditor = () => {
				const editor = installedFactory!(tui, theme, keybindings);
				editor.setAutocompleteProvider(createEditorBaseProvider());
				return editor;
			};

			const mentionEditor = createEditor();
			mentionEditor.handleInput("$");
			expect(mentionEditor.isShowingAutocomplete()).toBe(true);
			expect((mentionEditor as any).autocompleteList?.getSelectedItem?.()?.value).toBe("$commit");

			const thinkingEditor = createEditor();
			thinkingEditor.handleInput("^");
			expect(thinkingEditor.isShowingAutocomplete()).toBe(true);
			expect((thinkingEditor as any).autocompleteList?.getSelectedItem?.()?.value).toBe("low");
		} finally {
			cleanupSession(sessionFile);
		}
	});
});
