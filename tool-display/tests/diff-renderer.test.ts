import { describe, expect, test } from "bun:test";
import { initTheme } from "@mariozechner/pi-coding-agent";
import { renderStyledDiff } from "../diff-renderer";

initTheme();

const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
} as any;

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("tool-display diff renderer", () => {
	test("renders a thick summary bar and normalizes tab-indented code", () => {
		const diff = [
			"@@ -1,2 +1,2 @@",
			"-1 \tconst removed = true;",
			"+1 \tconst added = true;",
			" 2 \treturn added;",
		].join("\n");

		const rendered = renderStyledDiff(diff, "sample.ts", theme).render(80).join("\n");
		const plain = stripAnsi(rendered);

		expect(plain).toContain("█");
		expect(plain).not.toContain("━");
		expect(plain).not.toContain("\t");
		expect(plain).toContain("const added = true;");
	});
});
