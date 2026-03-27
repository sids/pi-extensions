import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import {
	activeAgentDurationMs,
	carryForwardTimingDurations,
	elapsedDurationMs,
	filterPullRequestsByHeadOwner,
	formatContextLabel,
	formatContextPercent,
	formatElapsedMinutes,
	formatModelLabel,
	formatOpenAIParamsLabel,
	formatPullRequestLabel,
	formatRepoLabel,
	formatTokenCount,
	formatThinkingLevel,
	formatWorkingDirectory,
	isGitHubHost,
	normalizeGitBranch,
	parseAllowedGitHubHosts,
	parseGitRemoteRepo,
	parseOpenAIParamsEvent,
	pickPullRequest,
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

describe("parseOpenAIParamsEvent", () => {
	test("parses a valid openai-params event payload", () => {
		expect(
			parseOpenAIParamsEvent({
				source: "openai-params",
				cwd: "/work",
				fast: true,
				verbosity: "medium",
			}),
		).toEqual({
			source: "openai-params",
			cwd: "/work",
			fast: true,
			verbosity: "medium",
		});
	});

	test("rejects invalid payloads", () => {
		expect(parseOpenAIParamsEvent({ source: "other", cwd: "/work", fast: true, verbosity: "low" })).toBeNull();
		expect(parseOpenAIParamsEvent({ source: "openai-params", cwd: "/work", fast: "yes", verbosity: "low" })).toBeNull();
		expect(parseOpenAIParamsEvent({ source: "openai-params", cwd: "/work", fast: true, verbosity: "default" })).toBeNull();
	});
});

describe("formatOpenAIParamsLabel", () => {
	test("omits default state", () => {
		expect(formatOpenAIParamsLabel({ fast: false, verbosity: null })).toBeNull();
	});

	test("formats fast-only, verbosity-only, and combined labels", () => {
		expect(formatOpenAIParamsLabel({ fast: true, verbosity: null })).toBe("/fast");
		expect(formatOpenAIParamsLabel({ fast: false, verbosity: "low" })).toBe("🗣️low");
		expect(formatOpenAIParamsLabel({ fast: true, verbosity: "high" })).toBe("/fast 🗣️high");
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

describe("formatTokenCount", () => {
	test("formats small values directly", () => {
		expect(formatTokenCount(987)).toBe("987");
	});

	test("formats thousands and millions compactly", () => {
		expect(formatTokenCount(1_499)).toBe("1.5k");
		expect(formatTokenCount(54_321)).toBe("54k");
		expect(formatTokenCount(1_500_000)).toBe("1.5M");
	});

	test("handles unknown values", () => {
		expect(formatTokenCount(undefined)).toBe("--");
		expect(formatTokenCount(null)).toBe("--");
	});
});

describe("formatContextLabel", () => {
	test("shows percent and used tokens", () => {
		expect(formatContextLabel({ percent: 42.6, tokens: 54_321 })).toBe("43% (54k)");
	});

	test("falls back when usage is unknown", () => {
		expect(formatContextLabel(undefined)).toBe("--");
		expect(formatContextLabel({ percent: null, tokens: null })).toBe("--");
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

describe("elapsedDurationMs", () => {
	test("returns elapsed milliseconds for valid start times", () => {
		expect(elapsedDurationMs(1_000, 2_500)).toBe(1_500);
	});

	test("returns zero for null or backward times", () => {
		expect(elapsedDurationMs(null, 2_500)).toBe(0);
		expect(elapsedDurationMs(3_000, 2_500)).toBe(0);
	});
});

describe("activeAgentDurationMs", () => {
	test("combines completed and active turn duration", () => {
		expect(activeAgentDurationMs(2_000, 5_000, 8_500)).toBe(5_500);
	});

	test("falls back to completed duration when no active turn", () => {
		expect(activeAgentDurationMs(2_000, null, 8_500)).toBe(2_000);
	});
});

describe("carryForwardTimingDurations", () => {
	test("accumulates session and agent durations across resets", () => {
		const carried = carryForwardTimingDurations(5_000, 3_000, 10_000, 2_000, 11_000, 14_000);
		expect(carried).toEqual({
			sessionDurationCarryMs: 9_000,
			agentDurationCarryMs: 8_000,
		});

		const afterSecondReset = carryForwardTimingDurations(
			carried.sessionDurationCarryMs,
			carried.agentDurationCarryMs,
			14_000,
			0,
			null,
			18_000,
		);
		expect(afterSecondReset).toEqual({
			sessionDurationCarryMs: 13_000,
			agentDurationCarryMs: 8_000,
		});
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
