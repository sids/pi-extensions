import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { HerdrAgentState, HerdrReporter } from "../herdr-client";
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
	const stateReports: Array<{ state: HerdrAgentState; message?: string }> = [];
	const sessionReports: Array<{ source?: string }> = [];
	let markdownTransformer:
		| ((markdown: string, context: { messageType: string; isStreaming: boolean }) => string)
		| undefined;
	let branch: unknown[] = [];
	let mode = "tui";
	let idle = true;

	const reporter: HerdrReporter = {
		async reportSession(_ctx, source) {
			sessionReports.push({ source });
		},
		reportState(state, message) {
			stateReports.push({ state, message });
		},
	};

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
				for (const handler of extensionEventHandlers.get(channel) ?? []) {
					handler(data);
				}
			},
		},
	} as any;

	createHerdrIntegrationExtension(env, () => reporter)(pi);

	const ctx = {
		get mode() {
			return mode;
		},
		isIdle: () => idle,
		sessionManager: {
			getBranch: () => branch,
			getSessionFile: () => "/tmp/session.jsonl",
			getSessionId: () => "session-1",
		},
	} as any;

	return {
		stateReports,
		sessionReports,
		getHandlerCount(name: string) {
			return handlers.get(name)?.length ?? 0;
		},
		transformMarkdown(markdown: string, messageType: string, isStreaming = false) {
			return markdownTransformer?.(markdown, { messageType, isStreaming }) ?? markdown;
		},
		setMode(value: string) {
			mode = value;
		},
		setIdle(value: boolean) {
			idle = value;
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
		await harness.emit("session_start", { reason: "startup" });

		const [result] = await harness.emit("before_agent_start", { systemPrompt: "base prompt" });

		expect(result).toEqual({ systemPrompt: `base prompt\n\n${INPUT_NEEDED_INSTRUCTION}` });
	});

	test("does not modify prompts or report state outside a root TUI session", async () => {
		const harness = createHarness();
		harness.setMode("rpc");
		harness.setBranch([assistantEntry("Choose one.\n:input_needed:")]);

		await harness.emit("session_start", { reason: "startup" });
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
		expect(harness.sessionReports).toEqual([]);
		expect(harness.stateReports).toEqual([]);
	});

	test("hides complete and streaming marker prefixes from assistant rendering", async () => {
		const harness = createHarness();
		await harness.emit("session_start", { reason: "startup" });
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

	test("reports session identity and direct lifecycle state", async () => {
		const harness = createHarness();
		await harness.emit("session_start", { reason: "startup" });
		harness.setIdle(false);
		await harness.emit("agent_start");
		harness.setBranch([assistantEntry("Which runtime should I use?\n\n:input_needed:")]);
		harness.setIdle(true);
		await harness.emit("agent_settled");
		harness.setIdle(false);
		await harness.emit("agent_start");

		expect(harness.sessionReports).toEqual([
			{ source: "startup" },
			{ source: undefined },
			{ source: undefined },
		]);
		expect(harness.stateReports).toEqual([
			{ state: "idle", message: undefined },
			{ state: "working", message: undefined },
			{ state: "blocked", message: "input needed" },
			{ state: "working", message: undefined },
		]);
	});

	test("restores a persisted blocked state after session startup", async () => {
		const harness = createHarness();
		harness.setBranch([assistantEntry("Please choose.\n:input_needed:")]);

		await harness.emit("session_start", { reason: "resume" });
		expect(harness.stateReports).toEqual([{ state: "idle", message: undefined }]);
		await vi.runAllTimersAsync();

		expect(harness.stateReports).toEqual([
			{ state: "idle", message: undefined },
			{ state: "blocked", message: "input needed" },
		]);
	});

	test("does not restore a marker superseded by a later user response", async () => {
		const harness = createHarness();
		harness.setBranch([
			assistantEntry("Please choose.\n:input_needed:"),
			userEntry("Use Bun."),
		]);

		await harness.emit("session_start", { reason: "resume" });
		await vi.runAllTimersAsync();

		expect(harness.stateReports).toEqual([{ state: "idle", message: undefined }]);
	});

	test("aggregates structural waits into absolute state", async () => {
		const harness = createHarness();
		await harness.emit("session_start", { reason: "startup" });
		harness.setIdle(false);
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

		expect(harness.stateReports).toEqual([
			{ state: "idle", message: undefined },
			{ state: "working", message: undefined },
			{ state: "blocked", message: "input needed" },
			{ state: "working", message: undefined },
		]);
	});

	test("keeps direct state blocked until marker and structural waits clear", async () => {
		const harness = createHarness();
		await harness.emit("session_start", { reason: "startup" });
		harness.setIdle(false);
		await harness.emit("agent_start");
		harness.setBranch([assistantEntry("Need a decision.\n:input_needed:")]);
		harness.setIdle(true);
		await harness.emit("agent_settled");
		harness.emitExtensionEvent("pi:waiting-for-user-input", {
			source: "plan-md:request_user_input",
			id: "call-1",
			waiting: true,
		});

		harness.setIdle(false);
		await harness.emit("agent_start");
		expect(harness.stateReports.at(-1)).toEqual({ state: "blocked", message: "input needed" });
		harness.emitExtensionEvent("pi:waiting-for-user-input", {
			source: "plan-md:request_user_input",
			id: "call-1",
			waiting: false,
		});

		expect(harness.stateReports.at(-1)).toEqual({ state: "working", message: undefined });
	});
});
