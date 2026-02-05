import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import {
	formatContextPercent,
	formatModelLabel,
	formatRepoLabel,
	formatThinkingLevel,
	formatWorkingDirectory,
	normalizeGitBranch,
} from "../utils";

describe("formatModelLabel", () => {
	test("formats provider and model", () => {
		expect(formatModelLabel({ provider: "anthropic", id: "claude" })).toBe("anthropic/claude");
	});

	test("handles missing model", () => {
		expect(formatModelLabel(undefined)).toBe("none");
	});
});

describe("formatThinkingLevel", () => {
	test("uses fallback", () => {
		expect(formatThinkingLevel(" ")).toBe("off");
	});
});

describe("formatWorkingDirectory", () => {
	test("replaces home with tilde", () => {
		const home = os.homedir();
		expect(formatWorkingDirectory(home)).toBe("~");
		expect(formatWorkingDirectory(path.join(home, "projects"))).toBe("~/projects");
	});

	test("keeps non-home paths", () => {
		expect(formatWorkingDirectory("/tmp")).toBe("/tmp");
	});
});

describe("formatContextPercent", () => {
	test("rounds percent", () => {
		expect(formatContextPercent({ percent: 42.6 })).toBe("43%");
	});

	test("handles missing usage", () => {
		expect(formatContextPercent(undefined)).toBe("--");
	});
});

describe("normalizeGitBranch", () => {
	test("handles empty branch", () => {
		expect(normalizeGitBranch(null)).toBe("--");
	});
});

describe("formatRepoLabel", () => {
	test("combines cwd and branch", () => {
		expect(formatRepoLabel("/work", "main")).toBe("/work (main)");
	});

	test("falls back when branch missing", () => {
		expect(formatRepoLabel("/work", "")).toBe("/work (--)");
	});
});
