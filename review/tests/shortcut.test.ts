import { describe, expect, test, vi } from "vitest";
import { resolveReviewCommandName, resolveSubmitInput, startReviewFromShortcut } from "../shortcut";

describe("resolveSubmitInput", () => {
	test("uses a remapped submit key", () => {
		expect(resolveSubmitInput(["ctrl+s"])).toBe("\x1b[115;5u");
	});

	test("returns undefined when submit has no binding", () => {
		expect(resolveSubmitInput([])).toBeUndefined();
	});
});

describe("resolveReviewCommandName", () => {
	test("selects this extension's suffixed command by source path", () => {
		const commands = [
			{
				name: "review:1",
				source: "extension",
				sourceInfo: { path: "/extensions/other/index.ts" },
			},
			{
				name: "review:2",
				source: "extension",
				sourceInfo: { path: "/extensions/review/index.ts" },
			},
		] as any;

		expect(resolveReviewCommandName(commands, "/extensions/review/index.ts")).toBe("review:2");
	});
});

describe("startReviewFromShortcut", () => {
	test("prefills and synthetically submits the resolved review command", async () => {
		const editorTexts: string[] = [];
		const emittedInputs: string[] = [];
		const scheduled: Array<() => void> = [];
		const ctx = {
			mode: "tui",
			ui: {
				getEditorText: () => "",
				setEditorText: (text: string) => editorTexts.push(text),
				notify: vi.fn(),
			},
		} as any;

		const started = await startReviewFromShortcut(ctx, "review:2", {
			emitInput: (data) => emittedInputs.push(data),
			getSubmitKeys: async () => ["ctrl+s"],
			schedule: (callback) => scheduled.push(callback),
		});

		expect(started).toBe(true);
		expect(editorTexts).toEqual(["/review:2"]);
		expect(emittedInputs).toEqual([]);
		expect(scheduled).toHaveLength(1);
		scheduled[0]();
		expect(emittedInputs).toEqual(["\x1b[115;5u"]);
	});

	test("does not replace existing editor content", async () => {
		const notify = vi.fn();
		const ctx = {
			mode: "tui",
			ui: {
				getEditorText: () => "work in progress",
				setEditorText: vi.fn(),
				notify,
			},
		} as any;

		expect(await startReviewFromShortcut(ctx, "review")).toBe(false);
		expect(ctx.ui.setEditorText).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(
			"Clear the editor before starting review with Ctrl+Alt+R.",
			"warning",
		);
	});

	test("does not synthesize input outside TUI mode", async () => {
		const ctx = {
			mode: "rpc",
			ui: {
				getEditorText: vi.fn(),
				setEditorText: vi.fn(),
				notify: vi.fn(),
			},
		} as any;

		expect(await startReviewFromShortcut(ctx, "review")).toBe(false);
		expect(ctx.ui.getEditorText).not.toHaveBeenCalled();
	});

	test("does not prefill when submit has no configured binding", async () => {
		const notify = vi.fn();
		const ctx = {
			mode: "tui",
			ui: {
				getEditorText: () => "",
				setEditorText: vi.fn(),
				notify,
			},
		} as any;

		expect(await startReviewFromShortcut(ctx, "review", {
			getSubmitKeys: async () => [],
		})).toBe(false);
		expect(ctx.ui.setEditorText).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(
			"Ctrl+Alt+R could not resolve the configured submit key.",
			"warning",
		);
	});
});
