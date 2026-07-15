import { describe, expect, test, vi } from "vitest";
import { resolveInitialSideThinking, SideSessionController } from "../side-session";

describe("resolveInitialSideThinking", () => {
	test.each([
		["max", "medium"],
		["xhigh", "medium"],
		["high", "medium"],
		["medium", "low"],
		["low", "low"],
		["minimal", "minimal"],
		["off", "off"],
	] as const)("maps %s to %s", (input, expected) => {
		expect(resolveInitialSideThinking(input)).toBe(expected);
	});
});

function createControllerHarness() {
	let eventListener: ((event: any) => void) | undefined;
	let idle = true;
	const calls = {
		custom: [] as any[],
		prompts: [] as string[],
		abort: 0,
		dispose: 0,
		model: [] as any[],
	};
	const session = {
		get isIdle() {
			return idle;
		},
		get isStreaming() {
			return !idle;
		},
		model: { provider: "a", id: "one" },
		thinkingLevel: "medium",
		modelRegistry: { getAvailable: async () => [{ provider: "a", id: "one" }] },
		subscribe: (listener: (event: any) => void) => {
			eventListener = listener;
			return vi.fn();
		},
		sendCustomMessage: async (...args: any[]) => calls.custom.push(args),
		prompt: async (text: string) => {
			calls.prompts.push(text);
		},
		setModel: async (model: any) => {
			calls.model.push(model);
			session.model = model;
		},
		cycleModel: async () => undefined,
		cycleThinkingLevel: () => {
			session.thinkingLevel = "high";
			return "high";
		},
		setThinkingLevel: (level: string) => {
			session.thinkingLevel = level;
		},
		abort: async () => {
			calls.abort++;
			idle = true;
		},
		dispose: () => calls.dispose++,
	} as any;
	const parentView = {
		status: () => ({ unreadCount: 2, branchChanged: false }),
		dispose: vi.fn(),
	} as any;
	return {
		controller: new SideSessionController(session, parentView),
		emit: (event: any) => eventListener?.(event),
		setIdle: (value: boolean) => (idle = value),
		calls,
		parentView,
		session,
	};
}

describe("SideSessionController", () => {
	test("installs the summary before allowing prompts and then injects a hidden update notice", async () => {
		const harness = createControllerHarness();
		expect(await harness.controller.submit("too early")).toBe(false);
		expect(harness.calls.prompts).toEqual([]);
		await harness.controller.installParentSummary("Compact parent context");
		expect(harness.controller.state.summaryStatus).toBe("ready");
		expect(harness.calls.custom[0][0]).toMatchObject({ customType: "side:summary", display: false });
		expect(harness.calls.custom[0][0].content).toContain("Compact parent context");
		expect(harness.controller.state.transcript[0]).toMatchObject({
			kind: "summary",
			text: "Compact parent context",
			available: true,
		});
		expect(harness.controller.state.transcript[1]).toEqual({
			kind: "notice",
			text: "Parent summary ready",
		});
		expect(harness.controller.state.statusMessage).toBeUndefined();

		expect(await harness.controller.submit("What changed?")).toBe(true);
		expect(harness.calls.prompts).toEqual(["What changed?"]);
		expect(harness.calls.custom).toHaveLength(2);
		expect(harness.calls.custom[1][0]).toMatchObject({ customType: "side:parent-status", display: false });
		expect(harness.calls.custom[1][0].content).toContain("2 unread finalized entries");
		expect(harness.calls.custom[1][0].content).not.toContain("secret parent body");
		expect(harness.controller.state.transcript).toContainEqual({ kind: "user", text: "What changed?" });
	});

	test("normalizes streaming, finalized, and tool events", () => {
		const harness = createControllerHarness();
		harness.emit({ type: "agent_start" });
		const streamingMessage = {
			role: "assistant",
			content: [{ type: "text", text: "hello" }],
			stopReason: "stop",
		};
		harness.emit({
			type: "message_update",
			message: streamingMessage,
			assistantMessageEvent: { type: "text_delta", delta: "hello" },
		});
		expect(harness.controller.state.streamingMessage).toBe(streamingMessage);
		harness.emit({ type: "tool_execution_start", toolCallId: "call", toolName: "read", args: { path: "a.ts" } });
		harness.emit({
			type: "tool_execution_end",
			toolCallId: "call",
			isError: false,
			result: { content: [{ type: "text", text: "done" }] },
		});
		harness.emit({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "answer" }], stopReason: "stop" },
		});
		expect(harness.controller.state.transcript).toContainEqual({
			kind: "tool",
			id: "call",
			name: "read",
			args: { path: "a.ts" },
			status: "done",
			result: { content: [{ type: "text", text: "done" }], isError: false },
			partial: false,
		});
		expect(harness.controller.state.transcript).toContainEqual({
			kind: "assistant",
			message: { role: "assistant", content: [{ type: "text", text: "answer" }], stopReason: "stop" },
		});
		expect(harness.controller.state.streamingMessage).toBeUndefined();
	});

	test("changes only child model/thinking and disposes idempotently", async () => {
		const harness = createControllerHarness();
		await harness.controller.setModel({ provider: "b", id: "two" } as any);
		harness.controller.setThinkingLevel("low");
		expect(harness.session.model).toMatchObject({ provider: "b", id: "two" });
		expect(harness.session.thinkingLevel).toBe("low");

		harness.setIdle(false);
		await Promise.all([harness.controller.dispose(), harness.controller.dispose()]);
		expect(harness.calls.abort).toBe(1);
		expect(harness.calls.dispose).toBe(1);
		expect(harness.parentView.dispose).toHaveBeenCalledOnce();
	});
});
