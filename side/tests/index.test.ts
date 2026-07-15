import { describe, expect, test, vi } from "vitest";
import { registerSideExtension } from "../index";

function createPiHarness() {
	const commands = new Map<string, any>();
	const shortcuts = new Map<string, any>();
	const events = new Map<string, Array<(event?: any, ctx?: any) => Promise<void> | void>>();
	const pi = {
		registerCommand: (name: string, definition: any) => commands.set(name, definition),
		registerShortcut: (name: string, definition: any) => shortcuts.set(name, definition),
		on: (name: string, handler: any) => {
			events.set(name, [...(events.get(name) ?? []), handler]);
		},
		getThinkingLevel: () => "high",
		sendUserMessage: vi.fn(),
	} as any;
	return { pi, commands, shortcuts, events };
}

function createContext(overrides: Record<string, unknown> = {}) {
	const entries = [
		{
			type: "message",
			id: "leaf",
			parentId: null,
			timestamp: "x",
			message: { role: "user", content: [{ type: "text", text: "main" }], timestamp: 1 },
		},
	];
	const notifications: any[] = [];
	return {
		mode: "tui",
		hasUI: true,
		cwd: "/tmp/project",
		model: { provider: "test", id: "model" },
		getSystemPrompt: () => "system",
		isIdle: () => true,
		sessionManager: {
			getEntries: () => entries,
			getSessionId: () => "parent",
			getSessionFile: () => "/tmp/parent.jsonl",
			getLeafId: () => "leaf",
			getBranch: () => entries,
		},
		modelRegistry: {},
		ui: {
			notify: (...args: any[]) => notifications.push(args),
			select: vi.fn(),
			confirm: vi.fn(),
		},
		notifications,
		...overrides,
	} as any;
}

function createController() {
	const state = {
		transcript: [],
		streamingMessage: undefined,
		isRunning: false,
		summaryStatus: "pending" as const,
		model: { provider: "test", id: "model" },
		thinkingLevel: "low",
		statusMessage: undefined as string | undefined,
	};
	return {
		state,
		getToolDefinition: () => undefined,
		subscribe: () => () => undefined,
		submit: vi.fn(async () => true),
		installParentSummary: vi.fn(async (summary: string | null) => {
			(state as any).summaryStatus = summary ? "ready" : "unavailable";
			(state.transcript as any[]).push({
				kind: "summary",
				text: summary ?? "summary unavailable",
				available: Boolean(summary),
				timestamp: 1,
			});
		}),
		dispose: vi.fn(async () => undefined),
		getAvailableModels: async () => [],
		cycleModel: vi.fn(),
		cycleThinkingLevel: vi.fn(),
		abort: vi.fn(),
	} as any;
}

function installOverlayHarness(ctx: any) {
	let component: any;
	let done: (() => void) | undefined;
	const handle = {
		focus: vi.fn(),
		hide: vi.fn(),
		setHidden: vi.fn(),
	};
	const tui = { requestRender: vi.fn(), terminal: { rows: 40, columns: 120 } };
	const theme = {
		fg: (_name: string, text: string) => text,
		bold: (text: string) => text,
		getThinkingBorderColor: () => (text: string) => text,
	};
	const keybindings = {
		matches: (data: string, id: string) => data === "enter" && id === "tui.input.submit",
		getKeys: () => [],
	};
	ctx.ui.custom = (factory: any, options: any) => new Promise((resolve) => {
		done = () => resolve(undefined);
		component = factory(tui, theme, keybindings, done);
		options.onHandle?.(handle);
	});
	return {
		get component() { return component; },
		get done() { return done; },
		handle,
	};
}

describe("side extension", () => {
	test("guards non-TUI mode and missing model", async () => {
		const harness = createPiHarness();
		registerSideExtension(harness.pi);
		const command = harness.commands.get("side");
		const rpc = createContext({ mode: "rpc" });
		await command.handler("", rpc);
		expect(rpc.notifications).toContainEqual(["/side requires TUI mode.", "error"]);

		const missing = createContext({ model: undefined });
		await command.handler("", missing);
		expect(missing.notifications).toContainEqual(["Select a model before opening /side.", "error"]);
	});

	test("opens before summary completion, keeps inline text editable, then enables sending", async () => {
		const harness = createPiHarness();
		const controller = createController();
		let resolveSummary: (summary: string) => void = () => undefined;
		const summaryPromise = new Promise<string>((resolve) => { resolveSummary = resolve; });
		registerSideExtension(harness.pi, {
			summarize: async () => summaryPromise,
			createSession: async () => controller,
		});
		const ctx = createContext();
		const overlay = installOverlayHarness(ctx);

		await harness.commands.get("side").handler("inline draft", ctx);
		expect(overlay.component).toBeDefined();
		expect(controller.installParentSummary).not.toHaveBeenCalled();
		overlay.component.handleInput("enter");
		expect(controller.submit).not.toHaveBeenCalled();

		resolveSummary("summary ready");
		await vi.waitFor(() => expect(controller.installParentSummary).toHaveBeenCalledWith("summary ready"));
		overlay.component.handleInput("enter");
		await vi.waitFor(() => expect(controller.submit).toHaveBeenCalledWith("inline draft"));

		overlay.done?.();
		await vi.waitFor(() => expect(controller.dispose).toHaveBeenCalledOnce());
	});

	test("ctrl+shift+s opens and toggles visibility without disposing the child", async () => {
		const harness = createPiHarness();
		const controller = createController();
		registerSideExtension(harness.pi, {
			summarize: async () => "summary",
			createSession: async () => controller,
		});
		const ctx = createContext();
		const overlay = installOverlayHarness(ctx);
		const shortcut = harness.shortcuts.get("ctrl+shift+s");

		await shortcut.handler(ctx);
		await vi.waitFor(() => expect(controller.installParentSummary).toHaveBeenCalled());
		await shortcut.handler(ctx);
		expect(overlay.handle.setHidden).toHaveBeenNthCalledWith(1, true);
		expect(controller.dispose).not.toHaveBeenCalled();
		await shortcut.handler(ctx);
		expect(overlay.handle.setHidden).toHaveBeenNthCalledWith(2, false);
		expect(overlay.handle.focus).toHaveBeenCalledOnce();
		expect(controller.dispose).not.toHaveBeenCalled();

		overlay.done?.();
		await vi.waitFor(() => expect(controller.dispose).toHaveBeenCalledOnce());
	});

	test("summary failure is non-fatal and shutdown tears down the active child", async () => {
		const harness = createPiHarness();
		const controller = createController();
		registerSideExtension(harness.pi, {
			summarize: async () => { throw new Error("summary unavailable"); },
			createSession: async () => controller,
		});
		const ctx = createContext();
		installOverlayHarness(ctx);
		await harness.commands.get("side").handler("", ctx);
		await vi.waitFor(() => expect(controller.installParentSummary).toHaveBeenCalledWith(null));
		expect(ctx.notifications.some((item: any[]) => item[0].includes("summary unavailable"))).toBe(true);

		for (const handler of harness.events.get("session_shutdown") ?? []) {
			await handler();
		}
		expect(controller.dispose).toHaveBeenCalledOnce();
	});
});
