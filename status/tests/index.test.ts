import { describe, expect, test, vi } from "vitest";
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

function createHarness() {
	const handlers = new Map<string, Handler[]>();
	const eventHandlers = new Map<string, Array<(data: unknown) => void>>();
	const setWidgetCalls: WidgetCall[] = [];
	const execCalls: Array<{ command: string; args: string[]; options?: { cwd?: string; timeout?: number } }> = [];
	let thinkingLevel = "high";
	let sessionName: string | undefined;
	let gitBranch = "main";
	let gitRemote = "git@github.com:org/repo.git";
	let pullRequests: unknown[] = [];

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
		getSessionName() {
			return sessionName;
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
				return { stdout: `${gitBranch}\n`, stderr: "", code: 0, killed: false };
			}
			if (command === "git" && args.join(" ") === "config --get remote.origin.url") {
				return { stdout: `${gitRemote}\n`, stderr: "", code: 0, killed: false };
			}
			if (command === "gh" && args[0] === "pr" && args[1] === "list") {
				return { stdout: JSON.stringify(pullRequests), stderr: "", code: 0, killed: false };
			}
			throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
		},
	} as any;

	statusExtension(pi);

	const createCtx = (cwd: string) => ({
		hasUI: true,
		cwd,
		model: { provider: "openai", id: "gpt-5.4" },
		getContextUsage: () => ({ percent: 42.6, tokens: 54_321, contextWindow: 128_000 }),
		ui: {
			setWidget: (key: string, factory: WidgetCall["factory"], options?: unknown) => {
				setWidgetCalls.push({ key, factory, options });
			},
			setFooter() {},
			notify() {},
		},
	});

	return {
		async emit(name: string, event: any = {}, ctx: any) {
			for (const handler of handlers.get(name) ?? []) {
				await handler(event, ctx);
			}
		},
		emitExtensionEvent(channel: string, data: unknown) {
			pi.events.emit(channel, data);
		},
		createCtx,
		setWidgetCalls,
		execCalls,
		setThinkingLevel(level: string) {
			thinkingLevel = level;
		},
		setSessionName(value: string | undefined) {
			sessionName = value;
		},
		setGitBranch(value: string) {
			gitBranch = value;
		},
		setGitRemote(value: string) {
			gitRemote = value;
		},
		setPullRequests(value: unknown[]) {
			pullRequests = value;
		},
		renderLatestWidget(
			width = 200,
			fg: (name: string, text: string) => string = (_name, text) => text,
			key = "pi-status.details",
		) {
			const latest = [...setWidgetCalls].reverse().find((call) => call.key === key && typeof call.factory === "function");
			if (!latest?.factory) {
				throw new Error(`${key} widget was not rendered`);
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

	test("shows the dim path and PR above the editor", async () => {
		const harness = createHarness();
		harness.setPullRequests([
			{
				url: "https://github.com/org/repo/pull/42",
				state: "OPEN",
				headRefName: "main",
				headRepositoryOwner: { login: "org" },
			},
		]);
		const ctx = harness.createCtx("/tmp/status-project");

		try {
			await harness.emit("session_start", {}, ctx);
			const headerCall = [...harness.setWidgetCalls].reverse().find((call) => call.key === "pi-status.header");
			const statusCall = [...harness.setWidgetCalls].reverse().find((call) => call.key === "pi-status.details");
			const lines = harness
				.renderLatestWidget(200, (name, text) => `<${name}>${text}</${name}>`, "pi-status.header")
				.map(normalizeLine);

			expect(headerCall?.options).toBeUndefined();
			expect(statusCall?.options).toEqual({ placement: "belowEditor" });
			expect(lines[0]).toContain("<dim>/tmp/status-project (main)</dim>");
			expect(lines[1]).toContain("<accent>https://github.com/org/repo/pull/42</accent>");
		} finally {
			await harness.emit("session_shutdown", {}, ctx);
		}
	});

	test("polls repository state independently after branch and remote changes", async () => {
		vi.useFakeTimers();
		const harness = createHarness();
		const ctx = harness.createCtx("/tmp/status-project");

		try {
			await harness.emit("session_start", {}, ctx);
			harness.setGitBranch("feature/status");
			harness.setGitRemote("git@github.com:other/new-repo.git");
			harness.setPullRequests([
				{
					url: "https://github.com/other/new-repo/pull/43",
					state: "OPEN",
					headRefName: "feature/status",
					headRepositoryOwner: { login: "other" },
				},
			]);

			await vi.advanceTimersByTimeAsync(5_000);

			const lines = harness.renderLatestWidget(200, undefined, "pi-status.header").map(normalizeLine);
			expect(lines[0]).toContain("/tmp/status-project (feature/status)");
			expect(lines[1]).toContain("https://github.com/other/new-repo/pull/43");
		} finally {
			await harness.emit("session_shutdown", {}, ctx);
			vi.useRealTimers();
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

	test("keeps one agent timer across low-level continuations until agent_settled", async () => {
		const originalDateNow = Date.now;
		let now = 0;
		Date.now = () => now;
		const harness = createHarness();
		const ctx = harness.createCtx("/tmp/status-project");

		try {
			await harness.emit("session_start", {}, ctx);
			await harness.emit("agent_start", {}, ctx);
			now = 2 * 60_000;
			await harness.emit("agent_end", {}, ctx);
			expect(normalizeLine(harness.renderLatestWidget()[0] ?? "")).toContain("2m agent");

			now = 3 * 60_000;
			await harness.emit("agent_start", {}, ctx);
			now = 5 * 60_000;
			await harness.emit("agent_settled", {}, ctx);
			expect(normalizeLine(harness.renderLatestWidget()[0] ?? "")).toContain("5m agent");
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
			expect(initialLine).not.toContain("🗣");

			const initialHeaderCount = harness.setWidgetCalls.filter((call) => call.key === "pi-status.header").length;
			const initialDetailsCount = harness.setWidgetCalls.filter((call) => call.key === "pi-status.details").length;
			const initialExecCount = harness.execCalls.length;
			await harness.emitExtensionEvent(OPENAI_PARAMS_EVENT_CHANNEL, {
				source: "openai-params",
				cwd: ctx.cwd,
				fast: true,
				longCache: true,
				verbosity: "low",
			});

			const updatedLine = normalizeLine(harness.renderLatestWidget()[0] ?? "");
			expect(harness.setWidgetCalls.filter((call) => call.key === "pi-status.header")).toHaveLength(initialHeaderCount);
			expect(harness.setWidgetCalls.filter((call) => call.key === "pi-status.details")).toHaveLength(
				initialDetailsCount + 1,
			);
			expect(harness.execCalls).toHaveLength(initialExecCount);
			expect(updatedLine).toContain("gpt-5.4 (high /fast cache:24h 🗣low) 43%/128k");
			expect(updatedLine).not.toContain("openai/");
		} finally {
			await harness.emit("session_shutdown", {}, ctx);
		}
	});

	test("refreshes the widget when session info changes", async () => {
		const harness = createHarness();
		const ctx = harness.createCtx("/tmp/status-project");

		try {
			await harness.emit("session_start", {}, ctx);
			const initialHeaderCount = harness.setWidgetCalls.filter((call) => call.key === "pi-status.header").length;
			const initialDetailsCount = harness.setWidgetCalls.filter((call) => call.key === "pi-status.details").length;
			const initialLine = normalizeLine(harness.renderLatestWidget(200, undefined, "pi-status.header")[0] ?? "");

			harness.setSessionName("build");
			await harness.emit("session_info_changed", { name: "build" }, ctx);

			const updatedLine = normalizeLine(harness.renderLatestWidget(200, undefined, "pi-status.header")[0] ?? "");
			expect(harness.setWidgetCalls.filter((call) => call.key === "pi-status.header")).toHaveLength(
				initialHeaderCount + 1,
			);
			expect(harness.setWidgetCalls.filter((call) => call.key === "pi-status.details")).toHaveLength(initialDetailsCount);
			expect(updatedLine).not.toBe(initialLine);
			expect(updatedLine).toContain("build ·");
		} finally {
			await harness.emit("session_shutdown", {}, ctx);
		}
	});

	test("uses the max thinking color for max reasoning", async () => {
		const harness = createHarness();
		const ctx = harness.createCtx("/tmp/status-project");

		try {
			harness.setThinkingLevel("max");
			await harness.emit("session_start", {}, ctx);

			const line = harness.renderLatestWidget(200, (name, text) => `<${name}>${text}</${name}>`)[0] ?? "";
			expect(line).toContain("<thinkingMax>max</thinkingMax>");
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
				longCache: true,
				verbosity: "low",
			});

			const line = harness.renderLatestWidget(200, (name, text) => `<${name}>${text}</${name}>`)[0] ?? "";
			expect(line).toContain("<thinkingHigh>high</thinkingHigh>");
			expect(line).toContain("<muted>/fast cache:24h 🗣low</muted>");
			expect(line).not.toContain("<thinkingHigh>/fast cache:24h 🗣low</thinkingHigh>");
		} finally {
			await harness.emit("session_shutdown", {}, ctx);
		}
	});

	test("does not show an additional tools line", async () => {
		const harness = createHarness();
		const ctx = harness.createCtx("/tmp/status-project");

		try {
			await harness.emit("session_start", {}, ctx);
			const lines = harness.renderLatestWidget(500).map(normalizeLine);

			expect(lines).toHaveLength(1);
			expect(lines[0]).not.toContain("Tools:");
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
