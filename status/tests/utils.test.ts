import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import {
	filterPullRequestsByHeadOwner,
	formatContextPercent,
	formatLoopMinutes,
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

describe("formatLoopMinutes", () => {
	test("formats minute count", () => {
		expect(formatLoopMinutes(0)).toBe("0min");
		expect(formatLoopMinutes(12.9)).toBe("12min");
	});

	test("handles missing values", () => {
		expect(formatLoopMinutes(undefined)).toBe("--");
		expect(formatLoopMinutes(null)).toBe("--");
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
