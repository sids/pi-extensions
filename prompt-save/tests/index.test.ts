import { beforeEach, describe, expect, mock, test } from "bun:test";

const clipboardCalls: string[] = [];
let clipboardError: Error | null = null;

mock.module("@mariozechner/pi-coding-agent", () => ({
	copyToClipboard: async (text: string) => {
		if (clipboardError) {
			throw clipboardError;
		}
		clipboardCalls.push(text);
	},
}));

const { default: promptSaveExtension, COPY_SHORTCUT, OPEN_PICKER_SHORTCUT, SAVE_SHORTCUT } = await import("../index");
const { MUTATION_ENTRY_TYPE, createAddPromptSaveMutation } = await import("../utils");

type Handler = (event: any, ctx: any) => any;

type HarnessOptions = {
	entries?: any[];
	editorText?: string;
};

function createTheme() {
	return {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => `<b>${text}</b>`,
		italic: (text: string) => `<i>${text}</i>`,
	};
}

function createHarness(options: HarnessOptions = {}) {
	const handlers = new Map<string, Handler[]>();
	const shortcuts = new Map<string, (ctx: any) => Promise<void> | void>();
	const entries = [...(options.entries ?? [])];
	const notifications: Array<{ message: string; type?: string }> = [];
	let editorText = options.editorText ?? "";
	let entryId = entries.length + 1;
	let pickerComponent: any;
	let renderRequests = 0;
	const tui = {
		requestRender() {
			renderRequests++;
		},
	};
	const theme = createTheme();

	const ctx = {
		hasUI: true,
		ui: {
			getEditorText: () => editorText,
			setEditorText: (text: string) => {
				editorText = text;
			},
			notify: (message: string, type?: string) => {
				notifications.push({ message, type });
			},
			custom: async (factory: any) => {
				return await new Promise((resolve) => {
					const done = (value: unknown) => resolve(value);
					pickerComponent = factory(tui as any, theme as any, {} as any, done);
				});
			},
		},
		sessionManager: {
			getEntries: () => entries,
		},
	};

	const pi = {
		on(name: string, handler: Handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		appendEntry(customType: string, data: unknown) {
			entries.push({
				type: "custom",
				id: `entry-${entryId++}`,
				customType,
				data,
			});
		},
		registerShortcut(shortcut: string, options: { handler: (ctx: any) => Promise<void> | void }) {
			shortcuts.set(shortcut, options.handler);
		},
	} as any;

	promptSaveExtension(pi);

	async function emit(name: string, event: any = {}) {
		const list = handlers.get(name) ?? [];
		for (const handler of list) {
			await handler(event, ctx);
		}
	}

	async function runShortcut(shortcut: string) {
		const handler = shortcuts.get(shortcut);
		if (!handler) {
			throw new Error(`Shortcut not registered: ${shortcut}`);
		}
		return await handler(ctx);
	}

	return {
		ctx,
		emit,
		runShortcut,
		getEntries: () => entries,
		getNotifications: () => notifications,
		getEditorText: () => editorText,
		setEditorText: (text: string) => {
			editorText = text;
		},
		getPickerComponent: () => pickerComponent,
		getRenderRequests: () => renderRequests,
		getShortcutKeys: () => [...shortcuts.keys()],
	};
}

beforeEach(() => {
	clipboardCalls.length = 0;
	clipboardError = null;
});

describe("prompt-save extension", () => {
	test("registers the expected shortcuts", () => {
		const harness = createHarness();

		expect(harness.getShortcutKeys().sort()).toEqual([COPY_SHORTCUT, OPEN_PICKER_SHORTCUT, SAVE_SHORTCUT].sort());
	});

	test("saves editor text on Alt+S and clears the editor", async () => {
		const harness = createHarness({ editorText: "saved prompt" });
		await harness.emit("session_start");

		await harness.runShortcut(SAVE_SHORTCUT);

		expect(harness.getEditorText()).toBe("");
		expect(harness.getEntries().at(-1)).toMatchObject({
			type: "custom",
			customType: MUTATION_ENTRY_TYPE,
			data: {
				version: 1,
				action: "add",
				item: {
					text: "saved prompt",
				},
			},
		});
		expect(harness.getNotifications()).toContainEqual({ message: "Saved prompt", type: "info" });
	});

	test("ignores empty or whitespace-only editor text on Alt+S", async () => {
		const harness = createHarness({ editorText: "   " });
		await harness.emit("session_start");

		await harness.runShortcut(SAVE_SHORTCUT);

		expect(harness.getEntries()).toHaveLength(0);
		expect(harness.getEditorText()).toBe("   ");
	});

	test("copies editor text on Ctrl+Alt+C, clears the editor only after success, and no-ops when empty", async () => {
		const harness = createHarness({ editorText: "copy me" });
		await harness.emit("session_start");

		await harness.runShortcut(COPY_SHORTCUT);

		expect(clipboardCalls).toEqual(["copy me"]);
		expect(harness.getEditorText()).toBe("");
		expect(harness.getEntries()).toHaveLength(0);
		expect(harness.getNotifications()).toContainEqual({ message: "Copied prompt to clipboard", type: "info" });

		harness.setEditorText("copy me again");
		clipboardError = new Error("no clipboard");
		await harness.runShortcut(COPY_SHORTCUT);
		expect(harness.getEditorText()).toBe("copy me again");
		expect(harness.getNotifications()).toContainEqual({ message: "Clipboard copy failed", type: "error" });

		harness.setEditorText("  ");
		clipboardError = null;
		await harness.runShortcut(COPY_SHORTCUT);
		expect(clipboardCalls).toEqual(["copy me"]);
		expect(harness.getNotifications()).toContainEqual({ message: "Editor is empty", type: "info" });
	});

	test("shows an empty state in the picker when there are no saved prompts", async () => {
		const harness = createHarness();
		await harness.emit("session_start");

		const openPromise = harness.runShortcut(OPEN_PICKER_SHORTCUT);
		const picker = harness.getPickerComponent();
		const lines = picker.render(160);
		expect(lines.join("\n")).toContain("No saved prompts in this session yet.");
		picker.handleInput("\x1b");
		await openPromise;
	});

	test("renders the picker shortcut hints inline", async () => {
		const harness = createHarness({
			entries: [
				{
					type: "custom",
					customType: MUTATION_ENTRY_TYPE,
					data: createAddPromptSaveMutation({ id: "prompt-1", text: "saved prompt", createdAt: 1 }),
				},
			],
		});
		await harness.emit("session_start");

		const openPromise = harness.runShortcut(OPEN_PICKER_SHORTCUT);
		const picker = harness.getPickerComponent();
		const rendered = picker.render(200).join("\n");
		expect(rendered).toContain("<b>Enter</b> <i>insert</i>");
		expect(rendered).toContain("<b>Ctrl+Alt+C</b> <i>copy</i>");
		expect(rendered).toContain("<b>Ctrl+D</b> <i>remove</i>");
		expect(rendered).toContain("<b>Esc</b>");
		expect(rendered).toContain("<i>close</i>");
		picker.handleInput("\x1b");
		await openPromise;
	});

	test("Enter populates an empty editor and appends to a non-empty editor", async () => {
		const savedEntries = [
			{
				type: "custom",
				customType: MUTATION_ENTRY_TYPE,
				data: createAddPromptSaveMutation({ id: "prompt-1", text: "saved prompt", createdAt: 1 }),
			},
		];
		const emptyHarness = createHarness({ entries: savedEntries, editorText: "" });
		await emptyHarness.emit("session_start");

		const emptyOpenPromise = emptyHarness.runShortcut(OPEN_PICKER_SHORTCUT);
		emptyHarness.getPickerComponent().handleInput("\r");
		await emptyOpenPromise;
		expect(emptyHarness.getEditorText()).toBe("saved prompt");

		const appendHarness = createHarness({ entries: savedEntries, editorText: "current prompt" });
		await appendHarness.emit("session_start");

		const appendOpenPromise = appendHarness.runShortcut(OPEN_PICKER_SHORTCUT);
		appendHarness.getPickerComponent().handleInput("\r");
		await appendOpenPromise;
		expect(appendHarness.getEditorText()).toBe("current prompt\nsaved prompt");
	});

	test("copies the selected saved prompt with Ctrl+Alt+C and keeps the picker open", async () => {
		const harness = createHarness({
			entries: [
				{
					type: "custom",
					customType: MUTATION_ENTRY_TYPE,
					data: createAddPromptSaveMutation({ id: "prompt-1", text: "saved prompt", createdAt: 1 }),
				},
			],
		});
		await harness.emit("session_start");

		let closed = false;
		const openPromise = harness.runShortcut(OPEN_PICKER_SHORTCUT).then(() => {
			closed = true;
		});
		harness.getPickerComponent().handleInput("\x1b\x03");
		await Promise.resolve();

		expect(clipboardCalls).toEqual(["saved prompt"]);
		expect(closed).toBe(false);
		harness.getPickerComponent().handleInput("\x1b");
		await openPromise;
	});

	test("Ctrl+D removes the selected prompt, keeps the picker open, and moves selection sensibly", async () => {
		const harness = createHarness({
			entries: [
				{
					type: "custom",
					customType: MUTATION_ENTRY_TYPE,
					data: createAddPromptSaveMutation({ id: "prompt-1", text: "first", createdAt: 1 }),
				},
				{
					type: "custom",
					customType: MUTATION_ENTRY_TYPE,
					data: createAddPromptSaveMutation({ id: "prompt-2", text: "second", createdAt: 2 }),
				},
				{
					type: "custom",
					customType: MUTATION_ENTRY_TYPE,
					data: createAddPromptSaveMutation({ id: "prompt-3", text: "third", createdAt: 3 }),
				},
			],
			editorText: "",
		});
		await harness.emit("session_start");

		let closed = false;
		const openPromise = harness.runShortcut(OPEN_PICKER_SHORTCUT).then(() => {
			closed = true;
		});
		const picker = harness.getPickerComponent();
		picker.handleInput("\x1b[B");
		picker.handleInput("\x04");
		await Promise.resolve();

		expect(closed).toBe(false);
		expect(harness.getEntries().at(-1)).toMatchObject({
			customType: MUTATION_ENTRY_TYPE,
			data: {
				version: 1,
				action: "delete",
				itemId: "prompt-2",
			},
		});
		expect(harness.getNotifications()).toContainEqual({
			message: "Removed saved prompt from the picker. Prompt text remains in session history.",
			type: "info",
		});
		picker.handleInput("\r");
		await openPromise;
		expect(harness.getEditorText()).toBe("first");
		expect(harness.getRenderRequests()).toBeGreaterThan(0);
	});

	test("Delete does not delete the selected saved prompt", async () => {
		const harness = createHarness({
			entries: [
				{
					type: "custom",
					customType: MUTATION_ENTRY_TYPE,
					data: createAddPromptSaveMutation({ id: "prompt-1", text: "first", createdAt: 1 }),
				},
				{
					type: "custom",
					customType: MUTATION_ENTRY_TYPE,
					data: createAddPromptSaveMutation({ id: "prompt-2", text: "second", createdAt: 2 }),
				},
			],
		});
		await harness.emit("session_start");

		const openPromise = harness.runShortcut(OPEN_PICKER_SHORTCUT);
		const picker = harness.getPickerComponent();
		picker.handleInput("\x1b[3~");
		await Promise.resolve();

		expect(harness.getEntries()).toHaveLength(2);
		picker.handleInput("\x1b");
		await openPromise;
	});
});
