import path from "node:path";
import type { ExtensionContext, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { matchesKey, type KeyId } from "@earendil-works/pi-tui";

export type ReviewShortcutDependencies = {
	emitInput?: (data: string) => void;
	getSubmitKeys?: (ctx: ExtensionContext) => Promise<KeyId[]>;
	schedule?: (callback: () => void) => void;
};

const FUNCTION_KEY_INPUTS: Partial<Record<string, string>> = {
	f1: "\x1bOP",
	f2: "\x1bOQ",
	f3: "\x1bOR",
	f4: "\x1bOS",
	f5: "\x1b[15~",
	f6: "\x1b[17~",
	f7: "\x1b[18~",
	f8: "\x1b[19~",
	f9: "\x1b[20~",
	f10: "\x1b[21~",
	f11: "\x1b[23~",
	f12: "\x1b[24~",
};

function encodeKeyInput(keyId: KeyId): string | undefined {
	const parts = keyId.split("+");
	const key = parts.pop();
	if (!key) {
		return undefined;
	}
	const modifiers = new Set(parts);
	const modifier = 1
		+ (modifiers.has("shift") ? 1 : 0)
		+ (modifiers.has("alt") ? 2 : 0)
		+ (modifiers.has("ctrl") ? 4 : 0)
		+ (modifiers.has("super") ? 8 : 0);
	const hasModifiers = modifiers.size > 0;

	const codepoints: Record<string, number> = {
		escape: 27,
		esc: 27,
		tab: 9,
		enter: 13,
		return: 13,
		space: 32,
		backspace: 127,
	};
	const codepoint = key.length === 1 ? key.charCodeAt(0) : codepoints[key];
	if (codepoint !== undefined) {
		return `\x1b[${codepoint};${modifier}u`;
	}

	const arrows: Record<string, string> = { up: "A", down: "B", right: "C", left: "D" };
	if (arrows[key]) {
		return `\x1b[1;${modifier}${arrows[key]}`;
	}

	const functions: Record<string, number> = {
		insert: 2,
		delete: 3,
		pageUp: 5,
		pageDown: 6,
	};
	if (functions[key]) {
		return `\x1b[${functions[key]};${modifier}~`;
	}
	if (key === "home" || key === "end") {
		return `\x1b[1;${modifier}${key === "home" ? "H" : "F"}`;
	}
	if (key === "clear") {
		if (!hasModifiers) return "\x1b[E";
		if (modifiers.size === 1 && modifiers.has("shift")) return "\x1b[e";
		if (modifiers.size === 1 && modifiers.has("ctrl")) return "\x1bOe";
		return undefined;
	}
	if (!hasModifiers) {
		return FUNCTION_KEY_INPUTS[key];
	}
	return undefined;
}

export function resolveSubmitInput(keys: KeyId[]): string | undefined {
	for (const key of keys) {
		const input = encodeKeyInput(key);
		if (input && matchesKey(input, key)) {
			return input;
		}
	}
	return undefined;
}

async function getConfiguredSubmitKeys(ctx: ExtensionContext): Promise<KeyId[]> {
	return await ctx.ui.custom<KeyId[]>((_tui, _theme, keybindings, done) => {
		queueMicrotask(() => done(keybindings.getKeys("tui.input.submit")));
		return {
			handleInput: () => {},
			invalidate: () => {},
			render: () => [],
		};
	});
}

export function resolveReviewCommandName(
	commands: SlashCommandInfo[],
	extensionPath: string,
): string | undefined {
	const normalizedPath = path.resolve(extensionPath);
	return commands.find(
		(command) => command.source === "extension" && path.resolve(command.sourceInfo.path) === normalizedPath,
	)?.name;
}

export async function startReviewFromShortcut(
	ctx: ExtensionContext,
	commandName: string,
	dependencies: ReviewShortcutDependencies = {},
): Promise<boolean> {
	if (ctx.mode !== "tui") {
		return false;
	}

	if (ctx.ui.getEditorText().trim()) {
		ctx.ui.notify("Clear the editor before starting review with Ctrl+Alt+R.", "warning");
		return false;
	}

	const getSubmitKeys = dependencies.getSubmitKeys ?? getConfiguredSubmitKeys;
	const submitInput = resolveSubmitInput(await getSubmitKeys(ctx));
	if (!submitInput) {
		ctx.ui.notify("Ctrl+Alt+R could not resolve the configured submit key.", "warning");
		return false;
	}

	ctx.ui.setEditorText(`/${commandName}`);
	const emitInput = dependencies.emitInput ?? ((data: string) => {
		process.stdin.emit("data", data);
	});
	const schedule = dependencies.schedule ?? ((callback: () => void) => {
		setTimeout(callback, 0);
	});
	schedule(() => emitInput(submitInput));
	return true;
}
