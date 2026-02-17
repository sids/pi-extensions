import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import {
	applyTitleAttention,
	clearTitleAttention,
	filterPullRequestsByHeadOwner,
	formatContextPercent,
	formatElapsedMinutes,
	formatModelLabel,
	formatPullRequestLabel,
	formatRepoLabel,
	formatThinkingLevel,
	formatWorkingDirectory,
	isGitHubHost,
	normalizeGitBranch,
	parseAllowedGitHubHosts,
	parseGitRemoteRepo,
	pickPullRequest,
	pickTitleStatus,
	shouldPromoteLongRunningToolWarning,
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

describe("pickTitleStatus", () => {
	test("prioritizes waiting for input", () => {
		expect(
			pickTitleStatus({
				isWaitingForInput: true,
				isRunning: true,
				isTyping: false,
				suppressDoneEmoji: false,
			}),
		).toBe("waitingForInput");
	});

	test("returns running when active and not waiting", () => {
		expect(
			pickTitleStatus({
				isWaitingForInput: false,
				isRunning: true,
				isTyping: false,
				suppressDoneEmoji: false,
			}),
		).toBe("running");
	});

	test("returns done when idle and emoji is not suppressed", () => {
		expect(
			pickTitleStatus({
				isWaitingForInput: false,
				isRunning: false,
				isTyping: false,
				suppressDoneEmoji: false,
			}),
		).toBe("done");
	});

	test("returns null when done emoji should stay hidden", () => {
		expect(
			pickTitleStatus({
				isWaitingForInput: false,
				isRunning: false,
				isTyping: true,
				suppressDoneEmoji: true,
			}),
		).toBeNull();
	});
});

describe("applyTitleAttention", () => {
	test("adds and removes attention ids with change detection", () => {
		const ids = new Set<string>();

		expect(applyTitleAttention(ids, "answer:1", true)).toBeTrue();
		expect(ids.has("answer:1")).toBeTrue();
		expect(applyTitleAttention(ids, "answer:1", true)).toBeFalse();

		expect(applyTitleAttention(ids, "answer:1", false)).toBeTrue();
		expect(ids.has("answer:1")).toBeFalse();
		expect(applyTitleAttention(ids, "answer:1", false)).toBeFalse();
	});
});

describe("clearTitleAttention", () => {
	test("clears all attention ids and reports whether anything changed", () => {
		const ids = new Set<string>(["answer:1", "answer:2"]);

		expect(clearTitleAttention(ids)).toBeTrue();
		expect(ids.size).toBe(0);
		expect(clearTitleAttention(ids)).toBeFalse();
	});
});

describe("shouldPromoteLongRunningToolWarning", () => {
	test("only promotes when timer ref still matches active timer", () => {
		const timers = new Map<string, unknown>();
		const activeTimer = Symbol("active");
		timers.set("tool-1", activeTimer);

		expect(shouldPromoteLongRunningToolWarning("tool-1", timers, activeTimer)).toBeTrue();

		timers.delete("tool-1");
		expect(shouldPromoteLongRunningToolWarning("tool-1", timers, activeTimer)).toBeFalse();

		const replacedTimer = Symbol("replaced");
		timers.set("tool-1", replacedTimer);
		expect(shouldPromoteLongRunningToolWarning("tool-1", timers, activeTimer)).toBeFalse();
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

	test("handles unknown percent", () => {
		expect(formatContextPercent({ percent: null })).toBe("--");
	});
});

describe("formatElapsedMinutes", () => {
	test("formats minutes only", () => {
		expect(formatElapsedMinutes(0)).toBe("0m");
		expect(formatElapsedMinutes(12.9)).toBe("12m");
		expect(formatElapsedMinutes(59)).toBe("59m");
	});

	test("formats hours and minutes", () => {
		expect(formatElapsedMinutes(60)).toBe("1h0m");
		expect(formatElapsedMinutes(75)).toBe("1h15m");
	});

	test("formats days, hours, and minutes", () => {
		expect(formatElapsedMinutes(1440)).toBe("1d0h0m");
		expect(formatElapsedMinutes(1505)).toBe("1d1h5m");
	});

	test("handles missing values", () => {
		expect(formatElapsedMinutes(undefined)).toBe("--");
		expect(formatElapsedMinutes(null)).toBe("--");
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

describe("parseGitRemoteRepo", () => {
	test("parses https remotes", () => {
		expect(parseGitRemoteRepo("https://github.com/org/repo.git")).toEqual({
			host: "github.com",
			owner: "org",
			name: "repo",
			repoSelector: "org/repo",
		});
	});

	test("parses ssh scp remotes", () => {
		expect(parseGitRemoteRepo("git@github.com:org/repo.git")).toEqual({
			host: "github.com",
			owner: "org",
			name: "repo",
			repoSelector: "org/repo",
		});
	});

	test("parses enterprise hosts", () => {
		expect(parseGitRemoteRepo("https://github.acme.local/org/repo")).toEqual({
			host: "github.acme.local",
			owner: "org",
			name: "repo",
			repoSelector: "github.acme.local/org/repo",
		});
	});

	test("returns null for invalid remotes", () => {
		expect(parseGitRemoteRepo("not-a-remote")).toBeNull();
	});
});

describe("parseAllowedGitHubHosts", () => {
	test("includes github.com by default", () => {
		expect(Array.from(parseAllowedGitHubHosts()).sort()).toEqual(["github.com"]);
	});

	test("adds configured hosts", () => {
		expect(Array.from(parseAllowedGitHubHosts("github.acme.local, ghe.example.com")).sort()).toEqual([
			"ghe.example.com",
			"github.acme.local",
			"github.com",
		]);
	});
});

describe("isGitHubHost", () => {
	test("accepts allowed hosts", () => {
		const allowed = parseAllowedGitHubHosts("github.acme.local");
		expect(isGitHubHost("github.com", allowed)).toBeTrue();
		expect(isGitHubHost("github.acme.local", allowed)).toBeTrue();
	});

	test("rejects unknown or spoofed hosts", () => {
		expect(isGitHubHost("github.com.evil.tld")).toBeFalse();
		expect(isGitHubHost("github.localhost")).toBeFalse();
		expect(isGitHubHost("gitlab.com")).toBeFalse();
		expect(isGitHubHost(undefined)).toBeFalse();
	});
});

describe("filterPullRequestsByHeadOwner", () => {
	test("prefers PRs from the expected owner when available", () => {
		expect(
			filterPullRequestsByHeadOwner(
				[
					{
						url: "https://github.com/org/repo/pull/1",
						headRefName: "feat/x",
						headRepositoryOwner: { login: "someone-else" },
					},
					{
						url: "https://github.com/org/repo/pull/2",
						headRefName: "feat/x",
						headRepositoryOwner: { login: "org" },
					},
				],
				"feat/x",
				"org",
			),
		).toEqual([
			{
				url: "https://github.com/org/repo/pull/2",
				headRefName: "feat/x",
				headRepositoryOwner: { login: "org" },
			},
		]);
	});

	test("returns empty when owner match is unavailable", () => {
		expect(
			filterPullRequestsByHeadOwner(
				[
					{
						url: "https://github.com/org/repo/pull/1",
						headRefName: "feat/x",
						headRepositoryOwner: { login: "fork-owner" },
					},
				],
				"feat/x",
				"org",
			),
		).toEqual([]);
	});
});

describe("pickPullRequest", () => {
	test("prefers open PR when present", () => {
		expect(
			pickPullRequest([
				{ url: "https://github.com/org/repo/pull/1", state: "CLOSED", updatedAt: "2026-01-01T00:00:00Z" },
				{ url: "https://github.com/org/repo/pull/2", state: "OPEN", updatedAt: "2026-01-02T00:00:00Z" },
			]),
		).toEqual({ url: "https://github.com/org/repo/pull/2", state: "OPEN", updatedAt: "2026-01-02T00:00:00Z" });
	});

	test("falls back to most recently updated when no open PR", () => {
		expect(
			pickPullRequest([
				{ url: "https://github.com/org/repo/pull/1", state: "CLOSED", updatedAt: "2026-01-01T00:00:00Z" },
				{ url: "https://github.com/org/repo/pull/2", state: "MERGED", updatedAt: "2026-01-03T00:00:00Z" },
			]),
		).toEqual({ url: "https://github.com/org/repo/pull/2", state: "MERGED", updatedAt: "2026-01-03T00:00:00Z" });
	});

	test("returns null for empty list", () => {
		expect(pickPullRequest([])).toBeNull();
	});
});

describe("formatPullRequestLabel", () => {
	test("shows url for open PR", () => {
		expect(formatPullRequestLabel({ url: "https://github.com/org/repo/pull/2", state: "OPEN" })).toBe(
			"PR: https://github.com/org/repo/pull/2",
		);
	});

	test("appends state when PR is not open", () => {
		expect(formatPullRequestLabel({ url: "https://github.com/org/repo/pull/2", state: "MERGED" })).toBe(
			"PR: https://github.com/org/repo/pull/2 (merged)",
		);
	});

	test("returns null when missing url", () => {
		expect(formatPullRequestLabel({ state: "OPEN" })).toBeNull();
	});
});
