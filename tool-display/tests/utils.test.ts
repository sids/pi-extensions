import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import {
	buildPreview,
	countFindResults,
	countGrepMatches,
	countLsEntries,
	countReadLines,
	formatDisplayPath,
	getDiffStats,
} from "../utils";

describe("tool-display utils", () => {
	test("counts read lines without trailing continuation notices", () => {
		const text = [
			"line 1",
			"line 2",
			"line 3",
			"",
			"[Showing lines 1-3 of 10. Use offset=4 to continue.]",
		].join("\n");

		expect(countReadLines(text)).toBe(3);
	});

	test("builds write previews with truncation metadata", () => {
		const preview = buildPreview(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"));

		expect(preview.previewLines).toHaveLength(10);
		expect(preview.previewLines[0]).toBe("line 1");
		expect(preview.previewLines[9]).toBe("line 10");
		expect(preview.hasMore).toBe(true);
		expect(preview.remainingLines).toBe(2);
	});

	test("counts only grep match lines when context lines are present", () => {
		const text = [
			"src/a.ts-9- before",
			"src/a.ts:10: match one",
			"src/a.ts-11- after",
			"src/b.ts:4: match two",
			"",
			"[Some lines truncated to 500 chars. Use read tool to see full lines]",
		].join("\n");

		expect(countGrepMatches(text)).toBe(2);
	});

	test("counts find results without trailing limit notices", () => {
		const text = [
			"tool-display/index.ts",
			"tool-display/utils.ts",
			"",
			"[1000 results limit reached. Use limit=2000 for more, or refine pattern]",
		].join("\n");

		expect(countFindResults(text)).toBe(2);
	});

	test("counts ls entries without trailing limit notices", () => {
		const text = [
			"index.ts",
			"tests/",
			"",
			"[500 entries limit reached. Use limit=1000 for more]",
		].join("\n");

		expect(countLsEntries(text)).toBe(2);
	});

	test("builds bash previews with truncation metadata", () => {
		const preview = buildPreview(Array.from({ length: 14 }, (_, index) => `out ${index + 1}`).join("\n"));

		expect(preview.previewLines).toHaveLength(10);
		expect(preview.hasMore).toBe(true);
		expect(preview.remainingLines).toBe(4);
	});

	test("computes edit diff stats and summary", () => {
		const diff = [
			"--- a/tool-display/index.ts",
			"+++ b/tool-display/index.ts",
			"@@ -1,3 +1,4 @@",
			" line one",
			"-line two",
			"+line two updated",
			"+line three",
			"@@ -10,1 +11,1 @@",
			"-line ten",
			"+line eleven",
		].join("\n");

		const stats = getDiffStats(diff);

		expect(stats.additions).toBe(3);
		expect(stats.removals).toBe(2);
		expect(stats.hunks).toBe(2);
		expect(stats.summary).toBe("diff • +3 • -2 • 2 hunks • 1 file • unified");
		expect(stats.bar.added + stats.bar.removed + stats.bar.neutral).toBe(10);
	});

	test("infers hunks for numbered edit diffs without @@ headers", () => {
		const diff = [
			" 10 before",
			"-11 old one",
			"+11 new one",
			" 12 between",
			" 20 around",
			"-21 old two",
			"+21 new two",
			" 22 after",
		].join("\n");

		const stats = getDiffStats(diff);

		expect(stats.additions).toBe(2);
		expect(stats.removals).toBe(2);
		expect(stats.hunks).toBe(2);
		expect(stats.summary).toBe("diff • +2 • -2 • 2 hunks • 1 file • unified");
	});

	test("formats relative, home, and ranged paths", () => {
		const home = homedir();

		expect(formatDisplayPath("tool-display/index.ts")).toBe("tool-display/index.ts");
		expect(formatDisplayPath(`${home}/src/pi-extensions/tool-display/index.ts`)).toBe(
			"~/src/pi-extensions/tool-display/index.ts",
		);
		expect(formatDisplayPath("tool-display/index.ts", { offset: 1, limit: 260 })).toBe(
			"tool-display/index.ts:1-260",
		);
		expect(formatDisplayPath("tool-display/index.ts", { offset: 20 })).toBe(
			"tool-display/index.ts:20-",
		);
	});
});
