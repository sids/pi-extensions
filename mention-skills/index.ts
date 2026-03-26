import { CustomEditor, type ExtensionAPI, type ExtensionUIContext } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem, AutocompleteProvider, EditorTheme, TUI } from "@mariozechner/pi-tui";
import type { KeybindingsManager } from "@mariozechner/pi-coding-agent";
import { composeRememberedSessionEditorComponent } from "@siddr/pi-shared-qna/session-editor-component";
import {
	buildSkillAutocompleteItems,
	collectDiscoveredSkills,
	createMentionAutocompleteProvider,
	findMentionTokenAtCursor,
	replaceSkillMentions,
} from "./utils";

/**
 * Thin editor subclass that adds $mention autocomplete triggering.
 *
 * All editing, rendering, history, paste, and keybinding behavior is
 * delegated to CustomEditor/Editor. This class only:
 * 1. Wraps the autocomplete provider to inject skill mention suggestions.
 * 2. Nudges autocomplete open when `$` is typed or when typing continues
 *    in a `$...` mention context.
 */
class MentionSkillsEditor extends CustomEditor {
	private getSkillItems: () => AutocompleteItem[];

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		getSkillItems: () => AutocompleteItem[],
	) {
		super(tui, theme, keybindings);
		this.getSkillItems = getSkillItems;
	}

	setAutocompleteProvider(provider: AutocompleteProvider): void {
		const wrapped = createMentionAutocompleteProvider(provider, this.getSkillItems);
		super.setAutocompleteProvider(wrapped);
	}

	handleInput(data: string): void {
		super.handleInput(data);

		// After super handles the keystroke, check if we need to trigger
		// mention autocomplete. The base editor auto-triggers for / and @,
		// but not for $.
		if (this.isShowingAutocomplete()) {
			return;
		}

		const isSinglePrintable = data.length === 1 && data.charCodeAt(0) >= 32;
		if (!isSinglePrintable) {
			return;
		}

		const lines = this.getLines();
		const cursor = this.getCursor();
		const line = lines[cursor.line] || "";
		const mention = findMentionTokenAtCursor(line, cursor.col);
		if (mention) {
			// tryTriggerAutocomplete is private in TypeScript but accessible at
			// runtime. This is the minimal surface needed to trigger the existing
			// autocomplete flow for $ context. Guarded to degrade gracefully if
			// the upstream method is renamed or removed.
			const self = this as any;
			if (typeof self.tryTriggerAutocomplete === "function") {
				self.tryTriggerAutocomplete();
			}
		}
	}
}

const SKILL_MENTION_EDITOR_ENHANCED = Symbol("mention-skills-editor-enhanced");

function enhanceEditorWithSkillMentions<TEditor extends CustomEditor>(
	editor: TEditor,
	getSkillItems: () => AutocompleteItem[],
): TEditor {
	const enhancedEditor = editor as TEditor & { [SKILL_MENTION_EDITOR_ENHANCED]?: boolean };
	if (enhancedEditor[SKILL_MENTION_EDITOR_ENHANCED]) {
		return editor;
	}
	enhancedEditor[SKILL_MENTION_EDITOR_ENHANCED] = true;
	const baseSetAutocompleteProvider = editor.setAutocompleteProvider?.bind(editor);
	if (baseSetAutocompleteProvider) {
		editor.setAutocompleteProvider = (provider: AutocompleteProvider) => {
			const wrapped = createMentionAutocompleteProvider(provider, getSkillItems);
			baseSetAutocompleteProvider(wrapped);
		};
	}

	const baseHandleInput = editor.handleInput.bind(editor);
	editor.handleInput = (data: string) => {
		baseHandleInput(data);

		if (editor.isShowingAutocomplete()) {
			return;
		}

		const isSinglePrintable = data.length === 1 && data.charCodeAt(0) >= 32;
		if (!isSinglePrintable) {
			return;
		}

		const lines = editor.getLines();
		const cursor = editor.getCursor();
		const line = lines[cursor.line] || "";
		const mention = findMentionTokenAtCursor(line, cursor.col);
		if (!mention) {
			return;
		}

		const self = editor as any;
		if (typeof self.tryTriggerAutocomplete === "function") {
			self.tryTriggerAutocomplete();
		}
	};

	return editor;
}

export default function (pi: ExtensionAPI) {
	let skillMap = new Map<string, string>();
	let skillItems: AutocompleteItem[] = [];

	function refreshSkillMap() {
		skillMap = collectDiscoveredSkills(pi.getCommands());
		skillItems = buildSkillAutocompleteItems(skillMap);
	}

	function installEditor(
		ctx: Pick<ExtensionUIContext, "cwd" | "sessionManager" | "ui"> & {
			ui: Pick<ExtensionUIContext, "setEditorComponent">;
		},
	) {
		composeRememberedSessionEditorComponent(ctx, (previousFactory) => {
			return (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => {
				const previousEditor = previousFactory?.(tui, theme, keybindings) as CustomEditor | undefined;
				if (previousEditor) {
					return enhanceEditorWithSkillMentions(previousEditor, () => skillItems);
				}

				return new MentionSkillsEditor(tui, theme, keybindings, () => skillItems);
			};
		});
	}

	pi.on("session_start", (_event, ctx) => {
		refreshSkillMap();
		if (ctx.hasUI) {
			installEditor(ctx);
		}
	});

	pi.on("session_switch", (_event, ctx) => {
		refreshSkillMap();
		if (ctx.hasUI) {
			installEditor(ctx);
		}
	});

	pi.on("resources_discover", () => {
		refreshSkillMap();
	});

	pi.on("input", (event, _ctx) => {
		if (skillMap.size === 0) {
			return { action: "continue" as const };
		}
		const replaced = replaceSkillMentions(event.text, skillMap);
		if (replaced === event.text) {
			return { action: "continue" as const };
		}
		return { action: "transform" as const, text: replaced, images: event.images };
	});
}
