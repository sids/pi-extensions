import { copyToClipboard, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { PromptSavePicker } from "./picker";
import {
	MUTATION_ENTRY_TYPE,
	addSavedPrompt,
	appendPromptToEditor,
	createAddPromptSaveMutation,
	createDeletePromptSaveMutation,
	createEmptyPromptSaveState,
	createSavedPromptItem,
	deleteSavedPrompt,
	getLatestPromptSaveStateFromEntries,
	hasMeaningfulText,
	type PromptSaveState,
	type SavedPromptItem,
} from "./utils";

export const SAVE_SHORTCUT = "alt+s";
export const OPEN_PICKER_SHORTCUT = "alt+shift+s";
export const COPY_SHORTCUT = "ctrl+alt+c";
const RAW_SAVE_SHORTCUT = "\x1bs";
const RAW_OPEN_PICKER_SHORTCUT = "\x1bS";

function getLatestPromptSaveState(ctx: ExtensionContext): PromptSaveState {
	return getLatestPromptSaveStateFromEntries(ctx.sessionManager.getEntries());
}

export default function promptSave(pi: ExtensionAPI) {
	let state = createEmptyPromptSaveState();
	let removeTerminalInputListener: (() => void) | undefined;

	const refreshState = (ctx: ExtensionContext) => {
		state = getLatestPromptSaveState(ctx);
	};

	const persistMutation = (nextState: PromptSaveState, mutation: unknown) => {
		state = nextState;
		pi.appendEntry(MUTATION_ENTRY_TYPE, mutation);
	};

	const copyText = async (ctx: ExtensionContext, text: string, message: string, options?: { clearEditor?: boolean }) => {
		try {
			await copyToClipboard(text);
			if (options?.clearEditor) {
				ctx.ui.setEditorText("");
			}
			ctx.ui.notify(message, "info");
			return true;
		} catch {
			ctx.ui.notify("Clipboard copy failed", "error");
			return false;
		}
	};

	const saveEditorText = (ctx: ExtensionContext) => {
		const editorText = ctx.ui.getEditorText();
		if (!hasMeaningfulText(editorText)) {
			return;
		}

		const item = createSavedPromptItem(editorText);
		const nextState = addSavedPrompt(getLatestPromptSaveState(ctx), item);
		persistMutation(nextState, createAddPromptSaveMutation(item));
		ctx.ui.setEditorText("");
		ctx.ui.notify("Saved prompt", "info");
	};

	const copyEditorText = async (ctx: ExtensionContext) => {
		const editorText = ctx.ui.getEditorText();
		if (!hasMeaningfulText(editorText)) {
			ctx.ui.notify("Editor is empty", "info");
			return;
		}

		await copyText(ctx, editorText, "Copied prompt to clipboard", { clearEditor: true });
	};

	const insertSavedPrompt = (ctx: ExtensionContext, item: SavedPromptItem) => {
		ctx.ui.setEditorText(appendPromptToEditor(ctx.ui.getEditorText(), item.text));
		ctx.ui.notify("Inserted saved prompt", "info");
	};

	const installRawShortcutCompatibility = (ctx: ExtensionContext) => {
		removeTerminalInputListener?.();
		removeTerminalInputListener = undefined;

		if (!ctx.hasUI) {
			return;
		}

		removeTerminalInputListener = ctx.ui.onTerminalInput((data) => {
			if (data === RAW_SAVE_SHORTCUT) {
				saveEditorText(ctx);
				return { consume: true };
			}

			if (data === RAW_OPEN_PICKER_SHORTCUT) {
				void openPromptPicker(ctx);
				return { consume: true };
			}

			return undefined;
		});
	};

	type PromptPickerResult =
		| {
				action: "use";
				item: SavedPromptItem;
		  }
		| {
				action: "close";
		  };

	const openPromptPicker = async (ctx: ExtensionContext) => {
		if (!ctx.hasUI) {
			return;
		}

		refreshState(ctx);
		const result = await ctx.ui.custom<PromptPickerResult>((tui, theme, _keybindings, done) =>
			new PromptSavePicker(tui, theme, state.items, {
				onClose: () => done({ action: "close" }),
				onUseItem: (item) => {
					done({ action: "use", item });
				},
				onCopyItem: (item) => {
					void copyText(ctx, item.text, "Copied saved prompt to clipboard");
				},
				onDeleteItem: (itemId) => {
					const nextState = deleteSavedPrompt(getLatestPromptSaveState(ctx), itemId);
					persistMutation(nextState, createDeletePromptSaveMutation(itemId));
					ctx.ui.notify("Removed saved prompt from the picker. Prompt text remains in session history.", "info");
					return nextState.items;
				},
			}),
		);

		if (result.action === "use") {
			insertSavedPrompt(ctx, result.item);
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		refreshState(ctx);
		installRawShortcutCompatibility(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		refreshState(ctx);
		installRawShortcutCompatibility(ctx);
	});

	pi.on("session_fork", async (_event, ctx) => {
		refreshState(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		refreshState(ctx);
	});

	pi.on("session_shutdown", async () => {
		removeTerminalInputListener?.();
		removeTerminalInputListener = undefined;
	});

	pi.registerShortcut(SAVE_SHORTCUT, {
		description: "Save editor text as a prompt",
		handler: async (ctx) => {
			saveEditorText(ctx);
		},
	});

	pi.registerShortcut(OPEN_PICKER_SHORTCUT, {
		description: "Open saved prompt picker",
		handler: async (ctx) => {
			await openPromptPicker(ctx);
		},
	});

	pi.registerShortcut(COPY_SHORTCUT, {
		description: "Copy editor text to clipboard and clear it",
		handler: async (ctx) => {
			await copyEditorText(ctx);
		},
	});
}
