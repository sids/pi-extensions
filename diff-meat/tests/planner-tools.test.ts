import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { loadDiffMeatConfig } from "../config";
import { abridgeDiff } from "../meat";

const PATCH = `diff --git a/app.ts b/app.ts
--- a/app.ts
+++ b/app.ts
@@ -1 +1 @@
-export const value = oldValue;
+export const value = newValue;
`;

function completion(content: any[]) {
	return {
		role: "assistant",
		content,
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "gpt-5.6-luna",
		usage: {
			input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function contextWithResponses(responses: any[], inspect?: (args: any[]) => void) {
	let index = 0;
	return {
		cwd: "/unused",
		isProjectTrusted: () => true,
		modelRegistry: {
			find: () => ({ id: "gpt-5.6-luna", provider: "openai-codex", contextWindow: 272_000, maxTokens: 128_000 }),
			hasConfiguredAuth: () => true,
			complete: async (...args: any[]) => {
				inspect?.(args);
				return responses[index++];
			},
		},
	} as any;
}

describe("planner source tools and cancellation", () => {
	test("confines read-only source inspection to the repository", async () => {
		const repository = await mkdtemp(path.join(tmpdir(), "diff-meat-tools-"));
		try {
			await writeFile(path.join(repository, "app.ts"), "export const oldValue = 1;\nexport const newValue = 2;\n");
			const calls: any[][] = [];
			const ctx = contextWithResponses([
				completion([{ type: "toolCall", id: "read-1", name: "read_file", arguments: { path: "app.ts", start_line: 1, end_line: 2 } }]),
				completion([{ type: "toolCall", id: "submit-1", name: "submit_diff_plan", arguments: {
					remove: [], fold: [], replace: [], drop_files: [], summary: "Changes the exported value.",
				} }]),
			], (args) => calls.push(args));
			const config = loadDiffMeatConfig({ DIFF_MEAT_CACHE: "0", DIFF_MEAT_SOURCE_INSPECTION: "1" });
			const pi = { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as any;

			await abridgeDiff(pi, ctx, PATCH, { config, repoRoot: repository });

			expect(calls[0][1].tools.map((tool: any) => tool.name)).toEqual(["read_file", "grep", "submit_diff_plan"]);
			const toolResult = calls[1][1].messages.find((message: any) => message.role === "toolResult");
			expect(toolResult.content[0].text).toContain("1: export const oldValue = 1;");
		} finally {
			await rm(repository, { recursive: true, force: true });
		}
	});

	test("propagates cancellation before making a model request", async () => {
		let completions = 0;
		const ctx = contextWithResponses([], () => completions++);
		const controller = new AbortController();
		controller.abort();
		const config = loadDiffMeatConfig({ DIFF_MEAT_CACHE: "0", DIFF_MEAT_SOURCE_INSPECTION: "0" });

		await expect(abridgeDiff({} as any, ctx, PATCH, {
			config,
			repoRoot: "/repo",
			signal: controller.signal,
		})).rejects.toThrow();
		expect(completions).toBe(0);
	});
});
