import { describe, expect, test } from "bun:test";
import statusExtension from "../index";
import { OPENAI_PARAMS_EVENT_CHANNEL } from "../utils";

type Handler = (event: any, ctx: any) => Promise<void> | void;

type WidgetCall = {
	key: string;
	factory: ((tui: unknown, theme: { fg: (name: string, text: string) => string }) => { render: (width: number) => string[] }) | undefined;
	options?: unknown;
};

function normalizeLine(line: string): string {
	return line.replace(/\s+/g, " ").trim();
}

async function flushAsyncWork() {
	await new Promise((resolve) => setTimeout(resolve, 0));
	await new Promise((resolve) => setTimeout(resolve, 0));
}

function createHarness() {
	const handlers = new Map<string, Handler[]>();
	const eventHandlers = new Map<string, Array<(data: unknown) => void>>();
	const setWidgetCalls: WidgetCall[] = [];
	const setFooterCalls: unknown[] = [];
	const execCalls: Array<{ command: string; args: string[]; options?: { cwd?: string; timeout?: number } }> = [];
	let thinkingLevel = "high";

	const pi = {
		on(name: string, handler: Handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		registerCommand() {},
		getThinkingLevel() {
			return thinkingLevel;
		},
		events: {
			on(channel: string, handler: (data: unknown) => void) {
				const list = eventHandlers.get(channel) ?? [];
				list.push(handler);
				eventHandlers.set(channel, list);
				return () => {
					eventHandlers.set(
						channel,
						(eventHandlers.get(channel) ?? []).filter((candidate) => candidate !== handler),
					);
				};
			},
			emit(channel: string, data: unknown) {
				for (const handler of eventHandlers.get(channel) ?? []) {
					handler(data);
				}
			},
		},
		async exec(command: string, args: string[], options?: { cwd?: string; timeout?: number }) {
			execCalls.push({ command, args, options });
			if (command === "git" && args.join(" ") === "rev-parse --abbrev-ref HEAD") {
				return { stdout: "main\n", stderr: "", code: 0, killed: false };
			}
			if (command === "git" && args.join(" ") === "config --get remote.origin.url") {
				return { stdout: "git@github.com:org/repo.git\n", stderr: "", code: 0, killed: false };
			}
			if (command === "gh" && args[0] === "pr" && args[1] === "list") {
				return { stdout: "[]", stderr: "", code: 0, killed: false };
			}
			throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
		},
	} as any;

	statusExtension(pi);

	const createCtx = (cwd: string) => ({
		hasUI: true,
		cwd,
		model: { provider: "openai", id: "gpt-5.4" },
		getContextUsage: () => ({ percent: 42.6, tokens: 54_321 }),
		ui: {
			setWidget: (key: string, factory: WidgetCall["factory"], options?: unknown) => {
				setWidgetCalls.push({ key, factory, options });
			},
			setFooter: (value: unknown) => {
				setFooterCalls.push(value);
			},
			notify() {},
		},
	});

	return {
		async emit(name: string, event: any = {}, ctx: any) {
			for (const handler of handlers.get(name) ?? []) {
				await handler(event, ctx);
			}
			await flushAsyncWork();
		},
		async emitExtensionEvent(channel: string, data: unknown) {
			pi.events.emit(channel, data);
			await flushAsyncWork();
		},
		createCtx,
		setWidgetCalls,
		setFooterCalls,
		execCalls,
		setThinkingLevel(level: string) {
			thinkingLevel = level;
		},
		renderLatestWidget(width = 200, fg: (name: string, text: string) => string = (_name, text) => text) {
			const latest = [...setWidgetCalls].reverse().find((call) => call.key === "status" && typeof call.factory === "function");
			if (!latest?.factory) {
				throw new Error("status widget was not rendered");
			}
			return latest.factory(
				{},
				{
					fg,
				},
			).render(width);
		},
	};
}

describe("status extension", () => {
	test("shows agent and turn total timing in the widget", async () => {
		const harness = createHarness();
		const ctx = harness.createCtx("/tmp/status-project");

		try {
			await harness.emit("session_start", {}, ctx);
			const line = normalizeLine(harness.renderLatestWidget()[0] ?? "");
			expect(line).toContain("agent");
			expect(line).toContain("turn total");
			expect(line).not.toContain(" loop ");
		} finally {
			await harness.emit("session_shutdown", {}, ctx);
		}
	});

	test("resets agent, turn total, and session timers on session_start", async () => {
		const originalDateNow = Date.now;
		let now = 0;
		Date.now = () => now;

		const harness = createHarness();
		const ctx = harness.createCtx("/tmp/status-project");

		try {
			await harness.emit("session_start", { reason: "startup" }, ctx);
			await harness.emit("agent_start", {}, ctx);
			now = 60_000;
			await harness.emit("turn_start", { turnIndex: 0, timestamp: now }, ctx);
			now = 4 * 60_000;
			await harness.emit("turn_end", { turnIndex: 0 }, ctx);

			const beforeReset = normalizeLine(harness.renderLatestWidget()[0] ?? "");
			expect(beforeReset).toContain("4m agent");
			expect(beforeReset).toContain("3m turn total");
			expect(beforeReset).toContain("4m session");

			now = 5 * 60_000;
			await harness.emit("session_start", { reason: "new" }, ctx);

			const afterReset = normalizeLine(harness.renderLatestWidget()[0] ?? "");
			expect(afterReset).toContain("-- agent");
			expect(afterReset).toContain("0m turn total");
			expect(afterReset).toContain("0m session");
		} finally {
			await harness.emit("session_shutdown", {}, ctx);
			Date.now = originalDateNow;
		}
	});

	test("re-renders with openai-params indicators inside the thinking parens", async () => {
		const harness = createHarness();
		const ctx = harness.createCtx("/tmp/status-project");

		try {
			await harness.emit("session_start", {}, ctx);
			const initialLine = normalizeLine(harness.renderLatestWidget()[0] ?? "");
			expect(initialLine).not.toContain("🗣️");

			const initialWidgetCount = harness.setWidgetCalls.length;
			await harness.emitExtensionEvent(OPENAI_PARAMS_EVENT_CHANNEL, {
				source: "openai-params",
				cwd: ctx.cwd,
				fast: true,
				verbosity: "low",
			});

			const updatedLine = normalizeLine(harness.renderLatestWidget()[0] ?? "");
			expect(harness.setWidgetCalls.length).toBeGreaterThan(initialWidgetCount);
			expect(updatedLine).toContain("openai/gpt-5.4 (high /fast 🗣️low) 43% (54k)");
		} finally {
			await harness.emit("session_shutdown", {}, ctx);
		}
	});

	test("applies the thinking color only to the thinking level text", async () => {
		const harness = createHarness();
		const ctx = harness.createCtx("/tmp/status-project");

		try {
			await harness.emit("session_start", {}, ctx);
			await harness.emitExtensionEvent(OPENAI_PARAMS_EVENT_CHANNEL, {
				source: "openai-params",
				cwd: ctx.cwd,
				fast: true,
				verbosity: "low",
			});

			const line = harness.renderLatestWidget(200, (name, text) => `<${name}>${text}</${name}>`)[0] ?? "";
			expect(line).toContain("<thinkingHigh>high</thinkingHigh>");
			expect(line).toContain("<muted>/fast 🗣️low</muted>");
			expect(line).not.toContain("<thinkingHigh>/fast 🗣️low</thinkingHigh>");
		} finally {
			await harness.emit("session_shutdown", {}, ctx);
		}
	});

	test("ignores openai-params events for a different cwd", async () => {
		const harness = createHarness();
		const ctx = harness.createCtx("/tmp/status-project-a");

		try {
			await harness.emit("session_start", {}, ctx);
			const initialWidgetCount = harness.setWidgetCalls.length;
			const initialLine = normalizeLine(harness.renderLatestWidget()[0] ?? "");

			await harness.emitExtensionEvent(OPENAI_PARAMS_EVENT_CHANNEL, {
				source: "openai-params",
				cwd: "/tmp/status-project-b",
				fast: true,
				verbosity: "high",
			});

			const updatedLine = normalizeLine(harness.renderLatestWidget()[0] ?? "");
			expect(harness.setWidgetCalls.length).toBe(initialWidgetCount);
			expect(updatedLine).toBe(initialLine);
		} finally {
			await harness.emit("session_shutdown", {}, ctx);
		}
	});
});
