import { describe, expect, test } from "vitest";
import { OpenAIParamsScreen } from "../settings-screen";
import type { OpenAIParamsState } from "../utils";

function createScreen(onSave: (state: OpenAIParamsState) => void) {
	const tui = { requestRender() {} } as any;
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
	} as any;
	return new OpenAIParamsScreen(
		tui,
		theme,
		{ fast: false, longCache: false, verbosity: undefined },
		{ onSave, onCancel() {} },
	);
}

describe("OpenAIParamsScreen", () => {
	test("toggles and saves long cache retention", () => {
		let saved: OpenAIParamsState | null = null;
		const screen = createScreen((state) => {
			saved = state;
		});

		expect(screen.render(100).join("\n")).toContain("Long cache: off");
		screen.handleInput("\x1b[B");
		screen.handleInput("\r");
		expect(screen.render(100).join("\n")).toContain("Long cache: on");

		screen.handleInput("\x13");
		expect(saved).toEqual({ fast: false, longCache: true, verbosity: undefined });
	});
});
