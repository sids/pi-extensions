import { CustomEditor, type ExtensionAPI, type ExtensionUIContext } from "@mariozechner/pi-coding-agent";
import type { KeybindingsManager } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, type AutocompleteItem, type AutocompleteProvider, type EditorTheme, type TUI } from "@mariozechner/pi-tui";
import {
	buildThinkingAutocompleteItems,
	createThinkingAutocompleteProvider,
	findThinkingTokenAtCursor,
	getAvailableThinkingLevels,
	stripThinkingLevelControlTokens,
	type ThinkingLevel,
	type ThinkingModel,
} from "./utils";

type PendingPrompt = {
	promptText: string;
	overrideLevel: ThinkingLevel | null;
};

type ActiveOverride = {
	previousLevel: ThinkingLevel;
};

function isTextUpdateInput(data: string): boolean {
	const isSinglePrintable = data.length === 1 && data.charCodeAt(0) >= 32;
	return isSinglePrintable || matchesKey(data, Key.backspace) || matchesKey(data, Key.delete);
}

function selectAutocompleteValue(editor: CustomEditor, value: string): void {
	const self = editor as any;
	const autocompleteList = self.autocompleteList as
		| {
				filteredItems?: AutocompleteItem[];
				setSelectedIndex?: (index: number) => void;
		  }
		| undefined;

	if (!autocompleteList || typeof autocompleteList.setSelectedIndex !== "function") {
		return;
	}

	const items = Array.isArray(autocompleteList.filteredItems) ? autocompleteList.filteredItems : undefined;
	if (!items) {
		return;
	}

	const index = items.findIndex((item) => item.value === value);
	if (index >= 0) {
		autocompleteList.setSelectedIndex(index);
	}
}

/**
 * Thin editor subclass that adds ^thinking autocomplete triggering.
 *
 * All editing, rendering, history, paste, and keybinding behavior is
 * delegated to CustomEditor/Editor. This class only:
 * 1. Wraps the autocomplete provider to inject thinking-level suggestions.
 * 2. Nudges autocomplete open when `^` is typed or when typing continues
 *    in a `^...` token context.
 * 3. Preselects the current thinking level when present in the suggestion set.
 */
export class PromptThinkingEditor extends CustomEditor {
	private getThinkingItems: () => AutocompleteItem[];
	private getCurrentThinkingLevel: () => ThinkingLevel;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		getThinkingItems: () => AutocompleteItem[],
		getCurrentThinkingLevel: () => ThinkingLevel,
	) {
		super(tui, theme, keybindings);
		this.getThinkingItems = getThinkingItems;
		this.getCurrentThinkingLevel = getCurrentThinkingLevel;
	}

	setAutocompleteProvider(provider: AutocompleteProvider): void {
		const wrapped = createThinkingAutocompleteProvider(provider, this.getThinkingItems);
		super.setAutocompleteProvider(wrapped);
	}

	private triggerThinkingAutocomplete(): void {
		const self = this as any;
		if (typeof self.tryTriggerAutocomplete === "function") {
			self.tryTriggerAutocomplete();
			this.selectCurrentThinkingLevel();
		}
	}

	private selectCurrentThinkingLevel(): void {
		selectAutocompleteValue(this, this.getCurrentThinkingLevel());
	}

	handleInput(data: string): void {
		super.handleInput(data);

		if (!isTextUpdateInput(data)) {
			return;
		}

		const lines = this.getLines();
		const cursor = this.getCursor();
		const line = lines[cursor.line] || "";
		const thinkingToken = findThinkingTokenAtCursor(line, cursor.col);
		if (!thinkingToken) {
			return;
		}

		if (!this.isShowingAutocomplete()) {
			// tryTriggerAutocomplete is private in TypeScript but accessible at
			// runtime. This is the minimal surface needed to trigger the existing
			// autocomplete flow for ^ context. Guarded to degrade gracefully if
			// the upstream method is renamed or removed.
			this.triggerThinkingAutocomplete();
			return;
		}

		this.selectCurrentThinkingLevel();
	}
}

export default function (pi: ExtensionAPI) {
	let currentModel: ThinkingModel | null = null;
	let currentThinkingLevel: ThinkingLevel = "off";
	let thinkingItems: AutocompleteItem[] = buildThinkingAutocompleteItems([currentThinkingLevel], currentThinkingLevel);
	let pendingPrompts: PendingPrompt[] = [];
	let activeOverride: ActiveOverride | null = null;

	function refreshThinkingItems(model?: ThinkingModel | null) {
		if (model !== undefined) {
			currentModel = model;
		}
		currentThinkingLevel = pi.getThinkingLevel() as ThinkingLevel;
		thinkingItems = buildThinkingAutocompleteItems(getAvailableThinkingLevels(currentModel), currentThinkingLevel);
	}

	function clearPromptState() {
		pendingPrompts = [];
		activeOverride = null;
	}

	function dequeuePrompt(promptText: string): PendingPrompt | undefined {
		const matchIndex = pendingPrompts.findIndex((entry) => entry.promptText === promptText);
		if (matchIndex < 0) {
			return undefined;
		}
		const staleCount = matchIndex;
		if (staleCount > 0) {
			pendingPrompts.splice(0, staleCount);
		}
		return pendingPrompts.shift();
	}

	function installEditor(ctx: { ui: Pick<ExtensionUIContext, "setEditorComponent"> }) {
		ctx.ui.setEditorComponent((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) =>
			new PromptThinkingEditor(tui, theme, keybindings, () => thinkingItems, () => currentThinkingLevel),
		);
	}

	pi.on("session_start", (_event, ctx) => {
		clearPromptState();
		refreshThinkingItems((ctx.model as ThinkingModel | undefined) ?? null);
		if (ctx.hasUI) {
			installEditor(ctx);
		}
	});

	pi.on("session_switch", (_event, ctx) => {
		clearPromptState();
		refreshThinkingItems((ctx.model as ThinkingModel | undefined) ?? null);
		if (ctx.hasUI) {
			installEditor(ctx);
		}
	});

	pi.on("session_shutdown", () => {
		if (activeOverride) {
			pi.setThinkingLevel(activeOverride.previousLevel);
			refreshThinkingItems();
		}
		clearPromptState();
	});

	pi.on("model_select", (event) => {
		refreshThinkingItems(event.model as ThinkingModel);
	});

	pi.on("input", (event, _ctx) => {
		if (event.source === "extension") {
			return { action: "continue" as const };
		}

		const transformed = stripThinkingLevelControlTokens(event.text);
		pendingPrompts.push({
			promptText: transformed.text,
			overrideLevel: transformed.overrideLevel,
		});

		if (!transformed.changed) {
			return { action: "continue" as const };
		}

		return {
			action: "transform" as const,
			text: transformed.text,
			images: event.images,
		};
	});

	pi.on("before_agent_start", (event) => {
		const pendingPrompt = dequeuePrompt(event.prompt);
		if (!pendingPrompt?.overrideLevel) {
			return;
		}

		const previousLevel = pi.getThinkingLevel() as ThinkingLevel;
		activeOverride = { previousLevel };
		pi.setThinkingLevel(pendingPrompt.overrideLevel);
		refreshThinkingItems();
	});

	pi.on("agent_end", () => {
		if (!activeOverride) {
			return;
		}
		pi.setThinkingLevel(activeOverride.previousLevel);
		activeOverride = null;
		refreshThinkingItems();
	});
}
