import { describe, expect, test } from "vitest";
import {
	buildSideSummaryPrompt,
	parseSideSummaryResult,
	SIDE_SUMMARY_MAX_TOKENS,
	summarizeParentSnapshot,
} from "../summary";

function model() {
	return {
		provider: "anthropic",
		id: "claude",
		api: "anthropic-messages",
		name: "Claude",
		reasoning: true,
		baseUrl: "",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 4_000,
	} as any;
}

function entry(id: string, parentId: string | null, text: string) {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message: { role: "user", content: [{ type: "text", text }], timestamp: 1 },
	} as any;
}

describe("side summary", () => {
	test("summarizes only the captured branch and uses bounded cache-attributed completion", async () => {
		const calls: any[] = [];
		const entries = [entry("root", null, "root"), entry("captured", "root", "captured"), entry("other", "root", "other")];
		const snapshot = {
			sessionId: "session-1",
			sessionFile: "/tmp/session.jsonl",
			leafId: "captured",
			entries,
			entryIds: new Set(entries.map((item) => item.id)),
			model: model(),
			systemPrompt: "system",
			thinkingLevel: "high",
		};
		const summary = await summarizeParentSnapshot(
			{
				modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key", headers: { x: "y" }, env: { A: "B" } }) },
			} as any,
			snapshot,
			{
				now: () => 42,
				complete: async (...args: any[]) => {
					calls.push(args);
					return { role: "assistant", content: [{ type: "text", text: '{"summary":"Useful context"}' }], stopReason: "stop" } as any;
				},
			},
		);
		expect(summary).toBe("Useful context");
		expect(JSON.stringify(calls[0][1].messages)).toContain("captured");
		expect(JSON.stringify(calls[0][1].messages)).not.toContain('"other"');
		expect(calls[0][2]).toMatchObject({
			apiKey: "key",
			headers: { x: "y" },
			env: { A: "B" },
			maxTokens: SIDE_SUMMARY_MAX_TOKENS,
			sessionId: "session-1",
		});
		expect("reasoning" in calls[0][2]).toBe(false);
	});

	test("parses fenced JSON and strips generic headings", () => {
		expect(parseSideSummaryResult('```json\n{"summary":"# Side summary\\n\\nDetails"}\n```')).toBe("Details");
		expect(parseSideSummaryResult('{"summary":""}')).toBeNull();
		expect(parseSideSummaryResult("not json")).toBeNull();
		expect(buildSideSummaryPrompt()).toContain("below 800 words");
	});

	test("surfaces provider failures and rejects unavailable snapshots", async () => {
		const base = {
			sessionId: "s",
			leafId: "root",
			entries: [entry("root", null, "hello")],
			entryIds: new Set(["root"]),
			model: model(),
			systemPrompt: "system",
			thinkingLevel: "low",
		};
		await expect(
			summarizeParentSnapshot(
				{ modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }) } } as any,
				base,
				{ complete: async () => ({ role: "assistant", content: [], stopReason: "error", errorMessage: "failed" }) as any },
			),
		).rejects.toThrow("failed");
		expect(await summarizeParentSnapshot({} as any, { ...base, leafId: "missing" })).toBeNull();
	});
});
