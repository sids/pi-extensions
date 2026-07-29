import { describe, expect, test } from "vitest";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import {
	areEquivalentHomePaths,
	encodeSessionDirectoryName,
	getEquivalentHomePath,
	getSessionLookupTargets,
	mergeSessionInfos,
} from "../utils";

function createSessionInfo(path: string, modified: string): SessionInfo {
	return {
		path,
		id: path,
		cwd: "/Users/alex/src/project",
		created: new Date("2026-01-01T00:00:00Z"),
		modified: new Date(modified),
		messageCount: 1,
		firstMessage: "hello",
		allMessagesText: "hello",
	};
}

describe("getEquivalentHomePath", () => {
	test("maps macOS and Linux home paths in both directions", () => {
		expect(getEquivalentHomePath("/Users/alex/src/project")).toBe("/home/alex/src/project");
		expect(getEquivalentHomePath("/home/alex/src/project")).toBe("/Users/alex/src/project");
		expect(getEquivalentHomePath("/Users/alex")).toBe("/home/alex");
	});

	test("does not map paths outside supported home layouts", () => {
		expect(getEquivalentHomePath("/usr/home/alex/project")).toBeUndefined();
		expect(getEquivalentHomePath("/Users")).toBeUndefined();
		expect(getEquivalentHomePath("/tmp/project")).toBeUndefined();
	});
});

describe("areEquivalentHomePaths", () => {
	test("requires matching usernames and path suffixes", () => {
		expect(areEquivalentHomePaths("/Users/alex/src/project", "/home/alex/src/project")).toBe(true);
		expect(areEquivalentHomePaths("/Users/alex/src/project", "/home/sam/src/project")).toBe(false);
		expect(areEquivalentHomePaths("/Users/alex/src/project", "/home/alex/src/other")).toBe(false);
	});
});

describe("getSessionLookupTargets", () => {
	test("uses both platform-specific default session directories", () => {
		expect(getSessionLookupTargets("/Users/alex/src/project", "/sessions/--Users-alex-src-project--")).toEqual([
			{ cwd: "/Users/alex/src/project", sessionDir: "/sessions/--Users-alex-src-project--" },
			{ cwd: "/home/alex/src/project", sessionDir: "/sessions/--home-alex-src-project--" },
		]);
	});

	test("filters both cwd variants inside a custom session directory", () => {
		expect(getSessionLookupTargets("/home/alex/src/project", "/custom/sessions")).toEqual([
			{ cwd: "/home/alex/src/project", sessionDir: "/custom/sessions" },
			{ cwd: "/Users/alex/src/project", sessionDir: "/custom/sessions" },
		]);
	});

	test("keeps ordinary paths unchanged", () => {
		expect(getSessionLookupTargets("/work/project", "/custom/sessions")).toEqual([
			{ cwd: "/work/project", sessionDir: "/custom/sessions" },
		]);
	});
});

describe("session info helpers", () => {
	test("encodes session directory names using pi's path format", () => {
		expect(encodeSessionDirectoryName("/Users/alex/src/project")).toBe("--Users-alex-src-project--");
	});

	test("deduplicates by path and sorts newest first", () => {
		const older = createSessionInfo("/sessions/older.jsonl", "2026-01-02T00:00:00Z");
		const newer = createSessionInfo("/sessions/newer.jsonl", "2026-01-03T00:00:00Z");

		expect(mergeSessionInfos([[older, newer], [older]])).toEqual([newer, older]);
	});
});
