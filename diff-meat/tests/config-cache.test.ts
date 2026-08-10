import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { buildCacheKey, readCachedReadingDiff, writeCachedReadingDiff } from "../cache";
import { loadDiffMeatConfig } from "../config";
import type { ReadingDiff } from "../types";

const temporaryDirectories: string[] = [];
afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("diff-meat configuration", () => {
	test("uses Luna high defaults and accepts overrides", () => {
		expect(loadDiffMeatConfig({})).toEqual({
			modelProvider: "openai-codex",
			modelId: "gpt-5.6-luna",
			thinkingLevel: "high",
			maxChunkTokens: 120_000,
			retention: "balanced",
			sourceInspection: true,
			cache: true,
		});
		expect(loadDiffMeatConfig({
			DIFF_MEAT_MODEL: "opencode-go/gpt-5.6-luna",
			DIFF_MEAT_THINKING: "xhigh",
			DIFF_MEAT_RETENTION: "aggressive",
			DIFF_MEAT_MAX_CHUNK_TOKENS: "64000",
			DIFF_MEAT_SOURCE_INSPECTION: "false",
			DIFF_MEAT_CACHE: "0",
		})).toEqual(expect.objectContaining({
			modelProvider: "opencode-go",
			thinkingLevel: "xhigh",
			retention: "aggressive",
			maxChunkTokens: 64_000,
			sourceInspection: false,
			cache: false,
		}));
	});

	test("rejects malformed settings", () => {
		expect(() => loadDiffMeatConfig({ DIFF_MEAT_MODEL: "luna" })).toThrow("provider/model");
		expect(() => loadDiffMeatConfig({ DIFF_MEAT_THINKING: "huge" })).toThrow("DIFF_MEAT_THINKING");
	});
});

describe("reading diff cache", () => {
	test("round-trips results using content-addressed keys", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "diff-meat-cache-"));
		temporaryDirectories.push(directory);
		const env = { XDG_CACHE_HOME: directory };
		const key = buildCacheKey(["patch", "model", "protocol"]);
		const reading: ReadingDiff = {
			rawPatch: "diff --git a/a b/a\n",
			summary: "Changes a.",
			keptSections: 1,
			totalSections: 1,
			usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 },
			fromCache: false,
		};

		expect(await readCachedReadingDiff(key, env)).toBeNull();
		await writeCachedReadingDiff(key, reading, env);
		expect(await readCachedReadingDiff(key, env)).toEqual(reading);
	});
});
