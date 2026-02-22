import { describe, expect, test } from "bun:test";
import {
	applyPriorityShortcut,
	buildReviewTriageResult,
	createInitialTriageComments,
	normalizeReviewerNote,
	resolvePriorityShortcutInput,
} from "../triage-tui";

describe("createInitialTriageComments", () => {
	test("marks all comments kept by default", () => {
		const triage = createInitialTriageComments([
			{
				version: 1,
				id: "c1",
				runId: "run-1",
				priority: "P2",
				comment: "Issue",
				references: [],
				createdAt: 1,
			},
		]);

		expect(triage).toEqual([
			{
				id: "c1",
				keep: true,
				priority: "P2",
				comment: "Issue",
				references: [],
				originalPriority: "P2",
				note: "",
			},
		]);
	});
});

describe("applyPriorityShortcut", () => {
	test("maps shortcuts 0-3", () => {
		expect(applyPriorityShortcut("0", "P3")).toBe("P0");
		expect(applyPriorityShortcut("1", "P3")).toBe("P1");
		expect(applyPriorityShortcut("2", "P1")).toBe("P2");
		expect(applyPriorityShortcut("3", "P0")).toBe("P3");
		expect(applyPriorityShortcut("9", "P1")).toBe("P1");
	});
});

describe("resolvePriorityShortcutInput", () => {
	test("supports caret shortcuts", () => {
		expect(resolvePriorityShortcutInput("^0")).toBe("P0");
		expect(resolvePriorityShortcutInput("^1")).toBe("P1");
		expect(resolvePriorityShortcutInput("^2")).toBe("P2");
		expect(resolvePriorityShortcutInput("^3")).toBe("P3");
		expect(resolvePriorityShortcutInput("1")).toBeUndefined();
	});

	test("supports terminal control-sequence shortcuts", () => {
		expect(resolvePriorityShortcutInput("\u001b[48;5u")).toBe("P0");
		expect(resolvePriorityShortcutInput("\u001b[49;5u")).toBe("P1");
		expect(resolvePriorityShortcutInput("\u001b[27;5;50~")).toBe("P2");
		expect(resolvePriorityShortcutInput("\u001b[27;5;51~")).toBe("P3");
		expect(resolvePriorityShortcutInput("\u001b[27;5;99~")).toBeUndefined();
	});
});

describe("normalizeReviewerNote", () => {
	test("returns undefined for empty note", () => {
		expect(normalizeReviewerNote("   ")).toBeUndefined();
	});
});

describe("buildReviewTriageResult", () => {
	test("calculates kept/discarded counts and trims notes", () => {
		const result = buildReviewTriageResult([
			{
				id: "c1",
				keep: true,
				priority: "P1",
				comment: "kept",
				references: [],
				note: "  important  ",
				originalPriority: "P1",
			},
			{
				id: "c2",
				keep: false,
				priority: "P3",
				comment: "discard",
				references: [],
				note: "  ",
				originalPriority: "P3",
			},
		]);

		expect(result.keptCount).toBe(1);
		expect(result.discardedCount).toBe(1);
		expect(result.comments[0].note).toBe("important");
		expect(result.comments[1].note).toBeUndefined();
	});
});
