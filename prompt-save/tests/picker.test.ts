import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@mariozechner/pi-tui";
import { PromptSavePicker } from "../picker";

function createTheme() {
	return {
		fg: (color: string, text: string) => {
			switch (color) {
				case "accent":
					return `\x1b[35m${text}\x1b[39m`;
				case "dim":
					return `\x1b[2m${text}\x1b[22m`;
				case "muted":
					return `\x1b[2m${text}\x1b[22m`;
				case "warning":
					return `\x1b[33m${text}\x1b[39m`;
				default:
					return text;
			}
		},
		bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
		italic: (text: string) => `\x1b[3m${text}\x1b[23m`,
	};
}

function createPicker(texts: string[]) {
	return new PromptSavePicker(
		{
			requestRender() {},
		} as any,
		createTheme() as any,
		texts.map((text, index) => ({
			id: `prompt-${index + 1}`,
			text,
			createdAt: index + 1,
		})),
		{
			onClose() {},
			onUseItem() {},
			onCopyItem() {},
			onDeleteItem() {
				return [];
			},
		},
	);
}

describe("PromptSavePicker", () => {
	test("renders single-line prompts without a multiline suffix", () => {
		const picker = createPicker(["single line prompt"]);
		const row = picker.render(120).find((line) => line.includes("single line prompt"));

		expect(row).toBeDefined();
		expect(row).not.toContain("(+");
	});

	test("renders multiline prompts with a dimmed extra-line suffix", () => {
		const picker = createPicker(["first line\nsecond line\nthird line"]);
		const row = picker.render(120).find((line) => line.includes("first line"));

		expect(row).toBeDefined();
		expect(row).toContain("(+2 lines)");
		expect(row).toContain("\x1b[2m (+2 lines)\x1b[22m");
	});

	test("uses wide layouts to show more of the first line", () => {
		const firstLine = "1234567890123456789012345678901234567890";
		const picker = createPicker([`${firstLine}\nsecond line`]);
		const row = picker.render(100).find((line) => line.includes(firstLine));

		expect(row).toBeDefined();
		expect(row).toContain(firstLine);
	});

	test("shows a same-color ... when the first line is truncated", () => {
		const picker = createPicker(["123456789012345678901234567890\nsecond line\nthird line"]);
		const row = picker.render(28).find((line) => line.includes("(+2 lines)"));

		expect(row).toBeDefined();
		expect(row).toContain("...");
		expect(row).toContain("\x1b[35m...\x1b[39m");
	});

	test("fits narrow layouts without overflowing", () => {
		const picker = createPicker(["123456789012345678901234567890\nsecond line\nthird line"]);
		const rendered = picker.render(28);

		for (const line of rendered) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(28);
		}
	});
});
