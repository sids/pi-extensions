import { describe, expect, test } from "bun:test";
import {
	formatReference,
	formatReviewSummaryMessage,
	getReviewTargetHint,
	normalizeReviewPriority,
	normalizeReviewReference,
	parsePrLocator,
	parsePrReference,
	parseReviewPaths,
} from "../utils";

describe("normalizeReviewPriority", () => {
	test("accepts valid priorities", () => {
		expect(normalizeReviewPriority("P0")).toBe("P0");
		expect(normalizeReviewPriority(" p1 ")).toBe("P1");
		expect(normalizeReviewPriority("p2")).toBe("P2");
		expect(normalizeReviewPriority("P3")).toBe("P3");
	});

	test("rejects invalid values", () => {
		expect(normalizeReviewPriority("P4")).toBeNull();
		expect(normalizeReviewPriority(123)).toBeNull();
	});
});

describe("normalizeReviewReference", () => {
	test("normalizes valid ranges", () => {
		const normalized = normalizeReviewReference({
			filePath: " ./src\\index.ts ",
			startLine: 10,
			endLine: 12,
		});

		expect(normalized).toEqual({
			filePath: "src/index.ts",
			startLine: 10,
			endLine: 12,
		});
		expect(formatReference(normalized!)).toBe("src/index.ts:10-12");
	});

	test("rejects invalid lines", () => {
		expect(
			normalizeReviewReference({
				filePath: "src/index.ts",
				startLine: 0,
			}),
		).toBeNull();

		expect(
			normalizeReviewReference({
				filePath: "src/index.ts",
				startLine: 8,
				endLine: 2,
			}),
		).toBeNull();
	});

	test("rejects malformed shapes without throwing", () => {
		expect(normalizeReviewReference({ startLine: 4 })).toBeNull();
		expect(normalizeReviewReference({ filePath: {}, startLine: 4 })).toBeNull();
		expect(normalizeReviewReference({ filePath: "src/index.ts", startLine: "nope" })).toBeNull();
	});
});

describe("parsePrLocator", () => {
	test("preserves full GitHub URL refs for gh commands", () => {
		expect(parsePrLocator("https://github.com/org/repo/pull/456")).toEqual({
			prNumber: 456,
			ghRef: "https://github.com/org/repo/pull/456",
		});
		expect(parsePrLocator("github.com/org/repo/pull/789?foo=1")).toEqual({
			prNumber: 789,
			ghRef: "https://github.com/org/repo/pull/789",
		});
	});

	test("preserves numeric refs", () => {
		expect(parsePrLocator("123")).toEqual({
			prNumber: 123,
			ghRef: "123",
		});
	});
});

describe("parsePrReference", () => {
	test("parses numeric references", () => {
		expect(parsePrReference("123")).toBe(123);
	});

	test("parses github url references", () => {
		expect(parsePrReference("https://github.com/org/repo/pull/456")).toBe(456);
		expect(parsePrReference("github.com/org/repo/pull/789")).toBe(789);
	});

	test("returns null for invalid refs", () => {
		expect(parsePrReference("abc")).toBeNull();
		expect(parsePrReference("https://github.com/org/repo/issues/12")).toBeNull();
		expect(parsePrLocator("https://github.com/org/repo/issues/12")).toBeNull();
	});
});

describe("parseReviewPaths", () => {
	test("splits by whitespace", () => {
		expect(parseReviewPaths("src docs\nREADME.md")).toEqual(["src", "docs", "README.md"]);
	});
});

describe("getReviewTargetHint", () => {
	test("uses selector wording for all target types", () => {
		expect(getReviewTargetHint({ type: "uncommitted" })).toBe("Review uncommitted changes");
		expect(getReviewTargetHint({ type: "baseBranch", branch: "main" })).toBe("Review against a base branch (local)");
		expect(getReviewTargetHint({ type: "commit", sha: "abc123" })).toBe("Review a commit");
		expect(getReviewTargetHint({ type: "custom", instructions: "check security" })).toBe("Custom review instructions");
		expect(getReviewTargetHint({ type: "pullRequest", prNumber: 12 })).toBe("Review a pull request (GitHub PR)");
		expect(getReviewTargetHint({ type: "folder", paths: ["src"] })).toBe(
			"Review a folder (or more) (snapshot, not diff)",
		);
	});
});

describe("formatReviewSummaryMessage", () => {
	test("uses Code Review Summary heading and comments section", () => {
		const message = formatReviewSummaryMessage({
			targetHint: "Review uncommitted changes",
			kept: [
				{
					id: "c1",
					keep: true,
					priority: "P1",
					comment: "Fix null check",
					references: [{ filePath: "src/a.ts", startLine: 12 }],
					note: "Double-check the edge case",
					originalPriority: "P1",
				},
			],
			discardedCount: 2,
			totalCount: 3,
		});

		expect(message).toContain("Code Review Summary");
		expect(message).toContain("Target: Review uncommitted changes");
		expect(message).toContain("Comments:");
		expect(message).toContain("1. [P1] Fix null check");
		expect(message).toContain("User Note: Double-check the edge case");
		expect(message).not.toContain("Review mode ended.");
		expect(message).not.toContain("Kept:");
		expect(message).not.toContain("Kept findings:");
	});

	test("inserts a blank line between kept comments", () => {
		const message = formatReviewSummaryMessage({
			kept: [
				{
					id: "c1",
					keep: true,
					priority: "P1",
					comment: "First finding",
					references: [],
					originalPriority: "P1",
				},
				{
					id: "c2",
					keep: true,
					priority: "P2",
					comment: "Second finding",
					references: [],
					originalPriority: "P2",
				},
			],
			discardedCount: 0,
			totalCount: 2,
		});

		expect(message).toContain("1. [P1] First finding\n\n2. [P2] Second finding");
	});
});
