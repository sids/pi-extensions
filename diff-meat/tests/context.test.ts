import { describe, expect, test } from "vitest";
import { buildCommitContext, buildConversationContext } from "../context";

describe("diff context", () => {
	test("keeps only user and assistant text from the active conversation branch", () => {
		const ctx = {
			sessionManager: {
				getBranch: () => [
					{ type: "message", message: { role: "user", content: "Change the retry behavior." } },
					{ type: "message", message: { role: "assistant", content: [
						{ type: "thinking", thinking: "Inspect first." },
						{ type: "text", text: "I’ll inspect the implementation." },
						{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "retry.ts" } },
					] } },
					{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "tool output" }] } },
					{ type: "custom_message", content: "injected context" },
					{ type: "message", message: { role: "assistant", content: [
						{ type: "toolCall", id: "edit-1", name: "edit", arguments: {} },
					] } },
					{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Implemented the retry change." }] } },
				],
			},
		} as any;

		expect(buildConversationContext(ctx)).toBe([
			"User:\nChange the retry behavior.",
			"Assistant:\nI’ll inspect the implementation.",
			"Assistant:\nImplemented the retry change.",
		].join("\n\n"));
	});

	test("feeds branch commit messages from commits unique to HEAD", async () => {
		const calls: string[][] = [];
		const pi = {
			exec: async (_command: string, args: string[]) => {
				calls.push(args);
				if (args[0] === "rev-parse") return { code: 0, stdout: "base-sha\n", stderr: "" };
				return { code: 0, stdout: "first-sha\0Add retries\n\0second-sha\0Handle timeout\n\0", stderr: "" };
			},
		} as any;

		const context = await buildCommitContext(pi, "/repo", { type: "baseBranch", branch: "main" });

		expect(calls[1]).toEqual(["log", "--format=%H%x00%B%x00", "base-sha..HEAD", "--"]);
		expect(context).toBe("Commit first-sha:\nAdd retries\n\nCommit second-sha:\nHandle timeout");
	});

	test("feeds the selected commit message for commit reviews", async () => {
		const calls: string[][] = [];
		const pi = {
			exec: async (_command: string, args: string[]) => {
				calls.push(args);
				if (args[0] === "rev-parse") return { code: 0, stdout: "commit-sha\n", stderr: "" };
				return { code: 0, stdout: "commit-sha\0Fix validation\n\nPreserve compatibility.\n\0", stderr: "" };
			},
		} as any;

		const context = await buildCommitContext(pi, "/repo", { type: "commit", sha: "abc123" });

		expect(calls[1]).toEqual(["log", "--format=%H%x00%B%x00", "commit-sha", "--"]);
		expect(context).toBe("Commit commit-sha:\nFix validation\n\nPreserve compatibility.");
	});
});
