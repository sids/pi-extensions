import { describe, expect, test, vi } from "vitest";
import { ParentSessionView, createParentSessionTools, sanitizeParentEntry } from "../parent-session";

function user(id: string, parentId: string | null, text: string) {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:00Z",
		message: { role: "user", content: [{ type: "text", text }], timestamp: 1 },
	} as any;
}

function createHarness() {
	let branch = [user("start", null, "initial")];
	let idle = false;
	let sessionId = "parent";
	const sent: any[] = [];
	const ctx = {
		isIdle: () => idle,
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => "/tmp/parent.jsonl",
			getBranch: () => [...branch],
		},
		ui: {
			confirm: vi.fn(),
		},
	} as any;
	const pi = { sendUserMessage: (...args: any[]) => sent.push(args) } as any;
	const snapshot = {
		sessionId: "parent",
		sessionFile: "/tmp/parent.jsonl",
		leafId: "start",
		entries: [...branch],
		entryIds: new Set(["start"]),
		model: {} as any,
		systemPrompt: "",
		thinkingLevel: "low",
	};
	return {
		view: new ParentSessionView(pi, ctx, snapshot),
		setBranch: (next: any[]) => (branch = next),
		setIdle: (next: boolean) => (idle = next),
		replaceSession: () => (sessionId = "replacement"),
		ctx,
		sent,
	};
}

describe("ParentSessionView", () => {
	test("tracks unread entries, pagination, and branch divergence", () => {
		const harness = createHarness();
		harness.setBranch([user("start", null, "initial"), user("next", "start", "later"), user("last", "next", "last")]);
		expect(harness.view.status()).toMatchObject({ parentState: "running", unreadCount: 2, branchChanged: false });

		const first = harness.view.updates(undefined, 1);
		expect(first.entries.map((entry) => entry.id)).toEqual(["next"]);
		expect(first.nextCursor).toBe("next");
		expect(first.remaining).toBe(1);
		expect(harness.view.status().unreadCount).toBe(1);

		harness.setBranch([user("alternate", null, "new branch")]);
		expect(harness.view.status()).toMatchObject({ branchChanged: true, cursorOnBranch: false });
		expect(harness.view.updates()).toMatchObject({ branchChanged: true, entries: [] });
	});

	test("searches and reads only the active branch", () => {
		const harness = createHarness();
		const assistant = {
			type: "message",
			id: "assistant",
			parentId: "start",
			timestamp: "x",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "Found auth logic" },
					{ type: "toolCall", id: "call", name: "read", arguments: { path: "auth.ts" } },
				],
			},
		} as any;
		harness.setBranch([user("start", null, "initial"), assistant]);
		expect(harness.view.search("AUTH", ["assistant"]).matches).toHaveLength(1);
		expect(harness.view.read(["assistant", "missing"])).toMatchObject({ missing: ["missing"] });
		expect(harness.view.read(["assistant"]).entries[0].text).toContain("Tool call: read");
	});

	test("omits image data from sanitized entries", () => {
		const sanitized = sanitizeParentEntry({
			type: "message",
			id: "image",
			parentId: null,
			timestamp: "x",
			message: {
				role: "user",
				content: [
					{ type: "text", text: "describe" },
					{ type: "image", data: "very-secret-base64", mimeType: "image/png" },
				],
			},
		} as any);
		expect(sanitized?.text).toBe("describe");
		expect(JSON.stringify(sanitized)).not.toContain("very-secret-base64");

		const toolCall = sanitizeParentEntry({
			type: "message",
			id: "tool-image",
			parentId: "image",
			timestamp: "x",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "call", name: "inspect", arguments: { data: "secret-tool-base64" } }],
			},
		} as any);
		expect(toolCall?.text).toContain("[binary content omitted]");
		expect(toolCall?.text).not.toContain("secret-tool-base64");
	});

	test("sends exact delivery directly and rejects empty or stale messages", async () => {
		const harness = createHarness();
		expect(await harness.view.sendMessage("  update main  ", "steer")).toMatchObject({ status: "sent", mode: "steer" });
		expect(await harness.view.sendMessage("later", "followUp")).toMatchObject({ status: "queued", mode: "followUp" });
		expect(harness.ctx.ui.confirm).not.toHaveBeenCalled();
		expect(harness.sent).toEqual([
			["update main", { deliverAs: "steer" }],
			["later", { deliverAs: "followUp" }],
		]);
		expect(await harness.view.sendMessage("   ", "steer")).toMatchObject({ status: "rejected" });

		harness.replaceSession();
		expect(await harness.view.sendMessage("stale", "followUp")).toMatchObject({ status: "stale" });
	});

	test("exposes strict bridge tool definitions", () => {
		const harness = createHarness();
		const tools = createParentSessionTools(harness.view);
		expect(tools.map((tool) => tool.name)).toEqual([
			"main_session_status",
			"main_session_updates",
			"main_session_search",
			"main_session_read",
			"main_session_send_message",
		]);
		for (const tool of tools) {
			expect(tool.constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });
			expect(tool.parameters.additionalProperties).toBe(false);
		}
	});
});
