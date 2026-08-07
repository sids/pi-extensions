import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createHerdrIntegrationExtension } from "../index";
import { INPUT_NEEDED_INSTRUCTION } from "../utils";

type Handler = (event: any, ctx: any) => unknown;

const HERDR_ENV = {
	HERDR_ENV: "1",
	HERDR_SOCKET_PATH: "/tmp/herdr.sock",
	HERDR_PANE_ID: "w1:p1",
};

function assistantEntry(text: string) {
	return {
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
		},
	};
}

function userEntry(text: string) {
	return {
		type: "message",
		message: {
			role: "user",
			content: text,
		},
	};
}

function createHarness(env: Record<string, string | undefined> = HERDR_ENV) {
	const handlers = new Map<string, Handler[]>();
	const extensionEventHandlers = new Map<string, Array<(data: unknown) => void>>();
	const emittedEvents: Array<{ channel: string; data: unknown }> = [];
	let markdownTransformer:
		| ((markdown: string, context: { messageType: string; isStreaming: boolean }) => string)
		| undefined;
	let branch: unknown[] = [];
	let hasUI = true;

	const pi = {
		on(name: string, handler: Handler) {
			const current = handlers.get(name) ?? [];
			current.push(handler);
			handlers.set(name, current);
		},
		registerMarkdownTransformer(
			transformer: (
				markdown: string,
				context: { messageType: string; isStreaming: boolean },
			) => string,
		) {
			markdownTransformer = transformer;
		},
		events: {
			on(channel: string, handler: (data: unknown) => void) {
				const current = extensionEventHandlers.get(channel) ?? [];
				current.push(handler);
				extensionEventHandlers.set(channel, current);
			},
			emit(channel: string, data: unknown) {
				emittedEvents.push({ channel, data });
				for (const handler of extensionEventHandlers.get(channel) ?? []) {
					handler(data);
				}
			},
		},
	} as any;

	createHerdrIntegrationExtension(env)(pi);

	const ctx = {
		get hasUI() {
			return hasUI;
		},
		sessionManager: {
			getBranch: () => branch,
		},
	} as any;

	return {
		emittedEvents,
		getHandlerCount(name: string) {
			return handlers.get(name)?.length ?? 0;
		},
		transformMarkdown(markdown: string, messageType: string, isStreaming = false) {
			return markdownTransformer?.(markdown, { messageType, isStreaming }) ?? markdown;
		},
		setHasUI(value: boolean) {
			hasUI = value;
		},
		setBranch(entries: unknown[]) {
			branch = entries;
		},
		emitExtensionEvent(channel: string, data: unknown) {
			pi.events.emit(channel, data);
		},
		async emit(name: string, event: any = {}) {
			const results = [];
			for (const handler of handlers.get(name) ?? []) {
				results.push(await handler(event, ctx));
			}
			return results;
		},
	};
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("herdr-integration extension", () => {
	test("does not register behavior outside a complete Herdr session", () => {
		const harness = createHarness({ HERDR_ENV: "1" });

		expect(harness.getHandlerCount("before_agent_start")).toBe(0);
		expect(harness.getHandlerCount("agent_settled")).toBe(0);
	});

	test("appends the input-needed instruction to the system prompt", async () => {
		const harness = createHarness();
		await harness.emit("session_start");

		const [result] = await harness.emit("before_agent_start", { systemPrompt: "base prompt" });

		expect(result).toEqual({ systemPrompt: `base prompt\n\n${INPUT_NEEDED_INSTRUCTION}` });
	});

	test("does not modify prompts or report blocked state without a root UI session", async () => {
		const harness = createHarness();
		harness.setHasUI(false);
		harness.setBranch([assistantEntry("Choose one.\n:input_needed:")]);

		await harness.emit("session_start");
		const [result] = await harness.emit("before_agent_start", { systemPrompt: "base prompt" });
		await harness.emit("agent_settled");
		harness.emitExtensionEvent("pi:waiting-for-user-input", {
			source: "plan-md:request_user_input",
			id: "call-1",
			waiting: true,
		});

		expect(result).toBeUndefined();
		expect(harness.transformMarkdown("Choose one.\n:input_needed:", "assistant")).toBe(
			"Choose one.\n:input_needed:",
		);
		expect(harness.emittedEvents.filter((event) => event.channel === "herdr:blocked")).toEqual([]);
	});

	test("hides complete and streaming marker prefixes from assistant rendering", async () => {
		const harness = createHarness();
		await harness.emit("session_start");
		const response = "Which runtime should I use?\n\n:input_needed:";

		for (let length = 1; length <= ":input_needed:".length; length += 1) {
			const partialResponse = `Which runtime should I use?\n\n${":input_needed:".slice(0, length)}`;
			expect(harness.transformMarkdown(partialResponse, "assistant", true)).toBe(
				"Which runtime should I use?",
			);
		}
		expect(harness.transformMarkdown(response, "assistant")).toBe("Which runtime should I use?");
		expect(harness.transformMarkdown(response, "user", true)).toBe(response);
	});

	test("marks Herdr blocked after a final assistant marker and clears it on the next run", async () => {
		const harness = createHarness();
		await harness.emit("session_start");
		await harness.emit("agent_start");
		harness.setBranch([assistantEntry("Which runtime should I use?\n\n:input_needed:")]);

		await harness.emit("agent_settled");
		await harness.emit("agent_settled");
		await harness.emit("agent_start");

		expect(harness.emittedEvents).toEqual([
			{
				channel: "herdr:blocked",
				data: { active: true, label: "input needed" },
			},
			{
				channel: "herdr:blocked",
				data: { active: false },
			},
		]);
	});

	test("restores a persisted blocked state after session startup handlers finish", async () => {
		const harness = createHarness();
		harness.setBranch([assistantEntry("Please choose.\n:input_needed:")]);

		await harness.emit("session_start");
		expect(harness.emittedEvents).toEqual([]);
		await vi.runAllTimersAsync();

		expect(harness.emittedEvents).toEqual([
			{
				channel: "herdr:blocked",
				data: { active: true, label: "input needed" },
			},
		]);
	});

	test("does not restore a marker superseded by a later user response", async () => {
		const harness = createHarness();
		harness.setBranch([
			assistantEntry("Please choose.\n:input_needed:"),
			userEntry("Use Bun."),
		]);

		await harness.emit("session_start");
		await vi.runAllTimersAsync();

		expect(harness.emittedEvents).toEqual([]);
	});

	test("aggregates structural waiting events without unbalanced Herdr events", async () => {
		const harness = createHarness();
		await harness.emit("session_start");
		await harness.emit("agent_start");

		harness.emitExtensionEvent("pi:waiting-for-user-input", {
			source: "plan-md:request_user_input",
			id: "call-1",
			waiting: true,
		});
		harness.emitExtensionEvent("pi:waiting-for-user-input", {
			source: "task-subagents:launch-review",
			id: "call-2",
			waiting: true,
		});
		harness.emitExtensionEvent("pi:waiting-for-user-input", {
			source: "plan-md:request_user_input",
			id: "call-1",
			waiting: false,
		});
		harness.emitExtensionEvent("pi:waiting-for-user-input", {
			source: "task-subagents:launch-review",
			id: "call-2",
			waiting: false,
		});

		expect(harness.emittedEvents.filter((event) => event.channel === "herdr:blocked")).toEqual([
			{
				channel: "herdr:blocked",
				data: { active: true, label: "input needed" },
			},
			{
				channel: "herdr:blocked",
				data: { active: false },
			},
		]);
	});

	test("keeps Herdr blocked until both marker and structural waits clear", async () => {
		const harness = createHarness();
		await harness.emit("session_start");
		await harness.emit("agent_start");
		harness.setBranch([assistantEntry("Need a decision.\n:input_needed:")]);
		await harness.emit("agent_settled");
		harness.emitExtensionEvent("pi:waiting-for-user-input", {
			source: "plan-md:request_user_input",
			id: "call-1",
			waiting: true,
		});

		await harness.emit("agent_start");
		expect(harness.emittedEvents).toHaveLength(2);
		harness.emitExtensionEvent("pi:waiting-for-user-input", {
			source: "plan-md:request_user_input",
			id: "call-1",
			waiting: false,
		});

		expect(harness.emittedEvents.filter((event) => event.channel === "herdr:blocked")).toEqual([
			{
				channel: "herdr:blocked",
				data: { active: true, label: "input needed" },
			},
			{
				channel: "herdr:blocked",
				data: { active: false },
			},
		]);
	});
});
