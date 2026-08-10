import { describe, expect, test } from "vitest";
import { loadDiffMeatConfig } from "../config";
import { abridgeDiff } from "../meat";
import { buildPlanChunks, detectMoveHints, enforceMoveSymmetry } from "../planner";
import {
	compileReadingDiff,
	parsePatch,
	validatePlan,
	type DiffEditPlan,
} from "../patch";

const PATCH = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,5 +1,5 @@ function run() {
 const a = 1;
-oldCall(verbose, errorMessage);
+newCall(verbose, errorMessage);
 keep();
-oldTail();
+newTail();
 }
diff --git a/generated.txt b/generated.txt
new file mode 100644
--- /dev/null
+++ b/generated.txt
@@ -0,0 +1,2 @@
+one
+two
`;

function emptyPlan(overrides: Partial<DiffEditPlan> = {}): DiffEditPlan {
	return { remove: [], fold: [], replace: [], dropFiles: [], summary: "Changes behavior.", ...overrides };
}

function completion(content: any[], stopReason = "toolUse") {
	return {
		role: "assistant",
		content,
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "gpt-5.6-luna",
		usage: {
			input: 100,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 120,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

describe("source-anchored reading diff", () => {
	test("parses files, hunks, and immutable physical line numbers", () => {
		const document = parsePatch(PATCH);
		expect(document.files.map((file) => ({ id: file.id, hunks: file.hunks.length }))).toEqual([
			{ id: "F1", hunks: 1 },
			{ id: "F2", hunks: 1 },
		]);
		expect(document.files[0]!.hunks[0]!.lines.map((line) => line.lineNo)).toEqual([6, 7, 8, 9, 10, 11, 12]);
	});

	test("applies removals and regenerates valid hunk coordinates", () => {
		const document = parsePatch(PATCH);
		const result = compileReadingDiff(document, emptyPlan({
			remove: [{ startLine: 9, endLine: 9 }],
		}));

		expect(result.rawPatch).toContain("@@ -1,2 +1,2 @@ function run() {");
		expect(result.rawPatch).toContain("@@ -4,2 +4,2 @@ function run() {");
		expect(result.rawPatch).toContain("oldTail");
		expect(result.rawPatch).toContain("newCall");
	});

	test("supports safe local elisions and machine-generated folds", () => {
		const document = parsePatch(PATCH);
		const result = compileReadingDiff(document, emptyPlan({
			replace: [{ line: 8, old: "verbose, errorMessage", new: "..." }],
			fold: [{ startLine: 18, endLine: 19 }],
		}));

		expect(result.rawPatch).toContain("+newCall(...);");
		expect(result.rawPatch).toContain("+...");
	});

	test("rejects overlapping and invented edits", () => {
		const document = parsePatch(PATCH);
		expect(() => validatePlan(document, emptyPlan({
			remove: [{ startLine: 7, endLine: 7 }],
			replace: [{ line: 7, old: "oldCall", new: "..." }],
		}))).toThrow("overlaps");
		expect(() => validatePlan(document, emptyPlan({
			replace: [{ line: 8, old: "newCall", new: "differentCall..." }],
		}))).toThrow("preserve source text");
	});

	test("drops complete generated files without orphan metadata", () => {
		const result = compileReadingDiff(parsePatch(PATCH), emptyPlan({ dropFiles: ["F2"] }));
		expect(result.rawPatch).not.toContain("generated.txt");
		expect(result.rawPatch).toContain("src/a.ts");
	});
});

describe("chunk planning", () => {
	test("keeps related hunks together within the token budget", () => {
		const chunks = buildPlanChunks(parsePatch(PATCH), 10_000);
		expect(chunks).toHaveLength(1);
		expect(chunks[0]!.hunks.map((hunk) => hunk.id)).toEqual(["F1:H1", "F2:H1"]);
	});

	test("detects exact multi-line moves", () => {
		const movePatch = `diff --git a/old.ts b/old.ts
--- a/old.ts
+++ b/old.ts
@@ -1,3 +1,1 @@
-alphaVeryLongMovedFunctionName();
-betaVeryLongMovedFunctionName();
 context();
diff --git a/new.ts b/new.ts
--- a/new.ts
+++ b/new.ts
@@ -1,1 +1,3 @@
 context();
+alphaVeryLongMovedFunctionName();
+betaVeryLongMovedFunctionName();
`;
		const hints = detectMoveHints(parsePatch(movePatch));
		expect(hints).toEqual([expect.objectContaining({
			removedHunk: "F1:H1",
			addedHunk: "F2:H1",
		})]);
		const asymmetric = enforceMoveSymmetry(emptyPlan({
			remove: [{ startLine: 5, endLine: 6 }],
		}), hints);
		expect(asymmetric.remove).toEqual([]);
	});
});

describe("model orchestration", () => {
	test("uses strict tools, configured reasoning, and reports usage", async () => {
		const calls: any[] = [];
		const progress: any[] = [];
		let completionIndex = 0;
		const model = {
			provider: "openai-codex",
			id: "gpt-5.6-luna",
			contextWindow: 272_000,
			maxTokens: 128_000,
		};
		const responses = [
			completion([{
				type: "toolCall",
				id: "submit-1",
				name: "submit_diff_plan",
				arguments: { remove: [], fold: [], replace: [], drop_files: ["F2"], summary: "Changes calls." },
			}]),
		];
		const ctx = {
			cwd: "/repo",
			isProjectTrusted: () => false,
			modelRegistry: {
				find: (provider: string, id: string) => {
					expect({ provider, id }).toEqual({ provider: "openai-codex", id: "gpt-5.6-luna" });
					return model;
				},
				hasConfiguredAuth: () => true,
				complete: async (...args: any[]) => {
					calls.push(args);
					return responses[completionIndex++];
				},
			},
		} as any;
		const pi = { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as any;
		const config = loadDiffMeatConfig({ DIFF_MEAT_CACHE: "0", DIFF_MEAT_SOURCE_INSPECTION: "0" });

		const result = await abridgeDiff(pi, ctx, PATCH, {
			config,
			repoRoot: "/repo",
			taskContext: "User:\nChange the call flow.\n\nAssistant:\nImplemented it.",
			onProgress: (update) => progress.push(update),
		});

		expect(calls).toHaveLength(1);
		expect(calls[0][1].tools[0]).toEqual(expect.objectContaining({
			name: "submit_diff_plan",
			constrainedSampling: { type: "json_schema", strict: "require" },
		}));
		expect(calls[0][2]).toEqual(expect.objectContaining({ reasoning: "high" }));
		expect(calls[0][1].messages[0].content[0].text).toContain("User:\nChange the call flow.");
		expect(calls[0][1].messages[0].content[0].text).toContain("diff --git a/src/a.ts b/src/a.ts");
		expect(result.rawPatch).not.toContain("generated.txt");
		expect(result.summary).toBe("Changes calls.");
		expect(result.usage).toEqual({ input: 100, output: 20, cacheRead: 0, cacheWrite: 0 });
		expect(progress.some((update) => update.message.includes("% retained"))).toBe(true);
	});

	test("runs the global pass only when token chunking produced multiple chunks", async () => {
		const bulk = "x".repeat(10_000);
		const largePatch = `diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-${bulk}a\n+${bulk}b\ndiff --git a/b.txt b/b.txt\n--- a/b.txt\n+++ b/b.txt\n@@ -1 +1 @@\n-${bulk}c\n+${bulk}d\n`;
		const responses = [
			completion([{ type: "toolCall", id: "submit-1", name: "submit_diff_plan", arguments: {
				remove: [], fold: [], replace: [], drop_files: [], summary: "Changes a.",
			} }]),
			completion([{ type: "toolCall", id: "submit-2", name: "submit_diff_plan", arguments: {
				remove: [], fold: [], replace: [], drop_files: [], summary: "Changes b.",
			} }]),
			completion([{ type: "toolCall", id: "global-1", name: "finalize_reading_diff", arguments: {
				drop_hunks: ["F2:H1"], drop_files: [], summary: "Changes a and removes redundant b details.",
			} }]),
		];
		let call = 0;
		const calls: any[] = [];
		const ctx = {
			cwd: "/repo",
			isProjectTrusted: () => false,
			modelRegistry: {
				find: () => ({ provider: "openai-codex", id: "gpt-5.6-luna", contextWindow: 272_000, maxTokens: 128_000 }),
				hasConfiguredAuth: () => true,
				complete: async (...args: any[]) => {
					calls.push(args);
					return responses[call++];
				},
			},
		} as any;
		const config = loadDiffMeatConfig({
			DIFF_MEAT_CACHE: "0",
			DIFF_MEAT_SOURCE_INSPECTION: "0",
			DIFF_MEAT_MAX_CHUNK_TOKENS: "8000",
		});

		const result = await abridgeDiff({} as any, ctx, largePatch, {
			config,
			repoRoot: "/repo",
			taskContext: "Commit abc123:\nExplain both file changes.",
		});

		expect(call).toBe(3);
		expect(calls[2][1].messages[0].content[0].text).toContain("Commit abc123:\nExplain both file changes.");
		expect(result.rawPatch).toContain("a.txt");
		expect(result.rawPatch).not.toContain("b.txt");
	});
});
