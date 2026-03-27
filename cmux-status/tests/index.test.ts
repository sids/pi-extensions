import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import cmuxStatusExtension from "../index";
import { formatCmuxStatusKey, formatCmuxStatusText, getCmuxStatusOwnerId, getCmuxStatusPresentation } from "../utils";

type Handler = (event: any, ctx: any) => Promise<void> | void;

type ExecCall = {
	command: string;
	args: string[];
	options?: {
		cwd?: string;
		timeout?: number;
	};
};

type IntervalCall = {
	id: number;
	callback: () => void;
	active: boolean;
};

const USER_INPUT_WAIT_EVENT = "pi:waiting-for-user-input";
const ORIGINAL_CMUX_WORKSPACE_ID = process.env.CMUX_WORKSPACE_ID;
const ORIGINAL_CMUX_SURFACE_ID = process.env.CMUX_SURFACE_ID;
const ORIGINAL_CMUX_PANEL_ID = process.env.CMUX_PANEL_ID;
const ORIGINAL_SET_INTERVAL = globalThis.setInterval;
const ORIGINAL_CLEAR_INTERVAL = globalThis.clearInterval;
let intervalCalls: IntervalCall[] = [];
let nextIntervalId = 1;

function restoreCmuxEnv() {
	if (ORIGINAL_CMUX_WORKSPACE_ID === undefined) {
		delete process.env.CMUX_WORKSPACE_ID;
	} else {
		process.env.CMUX_WORKSPACE_ID = ORIGINAL_CMUX_WORKSPACE_ID;
	}
	if (ORIGINAL_CMUX_SURFACE_ID === undefined) {
		delete process.env.CMUX_SURFACE_ID;
	} else {
		process.env.CMUX_SURFACE_ID = ORIGINAL_CMUX_SURFACE_ID;
	}
	if (ORIGINAL_CMUX_PANEL_ID === undefined) {
		delete process.env.CMUX_PANEL_ID;
	} else {
		process.env.CMUX_PANEL_ID = ORIGINAL_CMUX_PANEL_ID;
	}
}

function installIntervalMocks() {
	intervalCalls = [];
	nextIntervalId = 1;
	globalThis.setInterval = ((handler: TimerHandler, _timeout?: number, ...args: any[]) => {
		const id = nextIntervalId++;
		const callback = typeof handler === "function" ? () => handler(...args) : () => {};
		intervalCalls.push({ id, callback, active: true });
		return id as ReturnType<typeof setInterval>;
	}) as typeof setInterval;
	globalThis.clearInterval = ((id: ReturnType<typeof setInterval>) => {
		const match = intervalCalls.find((call) => call.id === Number(id));
		if (match) {
			match.active = false;
		}
	}) as typeof clearInterval;
}

function restoreIntervalMocks() {
	globalThis.setInterval = ORIGINAL_SET_INTERVAL;
	globalThis.clearInterval = ORIGINAL_CLEAR_INTERVAL;
	intervalCalls = [];
}

async function tickIntervals(times = 1) {
	for (let index = 0; index < times; index += 1) {
		for (const call of intervalCalls.filter((candidate) => candidate.active)) {
			call.callback();
			await flushAsyncWork();
		}
	}
}

function getActiveIntervalCount() {
	return intervalCalls.filter((call) => call.active).length;
}

async function flushAsyncWork() {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
	await new Promise((resolve) => setTimeout(resolve, 0));
}

function buildStatusKey() {
	return formatCmuxStatusKey(getCmuxStatusOwnerId());
}

function buildSetStatusArgs(
	statusKey: string,
	sessionName: string | undefined,
	status: "Ready" | "Working" | "Waiting" | "Error",
	workspaceId = "workspace:1",
	animationFrame = 0,
) {
	const presentation = getCmuxStatusPresentation(sessionName, status, animationFrame);
	const args = ["set-status", statusKey, presentation.text];
	if (presentation.icon) {
		args.push("--icon", presentation.icon);
	}
	if (presentation.color) {
		args.push("--color", presentation.color);
	}
	args.push("--workspace", workspaceId);
	return args;
}

function createHarness(options?: {
	initialStatuses?: Record<string, string>;
	sessionName?: string;
	notifyFails?: boolean;
	blockedSetStatusTexts?: string[];
}) {
	const handlers = new Map<string, Handler[]>();
	const eventHandlers = new Map<string, Array<(data: unknown) => void>>();
	const execCalls: ExecCall[] = [];
	const setWidgetCalls: unknown[] = [];
	const setFooterCalls: unknown[] = [];
	const notifications: Array<{ message: string; level?: string }> = [];
	let commandHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
	const statuses = new Map<string, string>(Object.entries(options?.initialStatuses ?? {}));
	const blockedSetStatusTexts = [...(options?.blockedSetStatusTexts ?? [])];
	const blockedSetStatusResolvers: Array<() => void> = [];
	let sessionName = options?.sessionName;

	const pi = {
		on(name: string, handler: Handler) {
			const current = handlers.get(name) ?? [];
			current.push(handler);
			handlers.set(name, current);
		},
		registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
			if (name === "custom-cmux-status") {
				commandHandler = command.handler;
			}
		},
		getSessionName() {
			return sessionName;
		},
		events: {
			on(channel: string, handler: (data: unknown) => void) {
				const current = eventHandlers.get(channel) ?? [];
				current.push(handler);
				eventHandlers.set(channel, current);
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
		async exec(command: string, args: string[], execOptions?: { cwd?: string; timeout?: number }) {
			execCalls.push({ command, args, options: execOptions });
			if (command === "cmux" && args[0] === "set-status") {
				const text = args[2] ?? "";
				const blockedIndex = blockedSetStatusTexts.indexOf(text);
				if (blockedIndex >= 0) {
					blockedSetStatusTexts.splice(blockedIndex, 1);
					return await new Promise((resolve) => {
						blockedSetStatusResolvers.push(() => {
							statuses.set(args[1] ?? "", text);
							resolve({ stdout: "", stderr: "", code: 0, killed: false });
						});
					});
				}
				statuses.set(args[1] ?? "", text);
				return { stdout: "", stderr: "", code: 0, killed: false };
			}
			if (command === "cmux" && args[0] === "clear-status") {
				statuses.delete(args[1] ?? "");
				return { stdout: "", stderr: "", code: 0, killed: false };
			}
			if (command === "cmux" && args[0] === "notify") {
				if (options?.notifyFails) {
					return { stdout: "", stderr: "notify failed", code: 1, killed: false };
				}
				return { stdout: "", stderr: "", code: 0, killed: false };
			}
			if (command === "cmux") {
				return { stdout: "", stderr: "", code: 0, killed: false };
			}
			throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
		},
	} as any;

	cmuxStatusExtension(pi);

	const ctx = {
		hasUI: true,
		cwd: "/tmp/project",
		ui: {
			setWidget: (value: unknown) => setWidgetCalls.push(value),
			setFooter: (value: unknown) => setFooterCalls.push(value),
			notify: (message: string, level?: string) => notifications.push({ message, level }),
		},
	} as any;

	async function emit(name: string, event: any = {}) {
		for (const handler of handlers.get(name) ?? []) {
			await handler(event, ctx);
		}
	}

	return {
		emit,
		emitExtensionEvent(channel: string, data: unknown) {
			pi.events.emit(channel, data);
		},
		setWorkspaceStatusText(key: string, value: string | null) {
			if (value === null) {
				statuses.delete(key);
				return;
			}
			statuses.set(key, value);
		},
		getWorkspaceStatusText(key: string) {
			return statuses.get(key) ?? null;
		},
		releaseNextBlockedSetStatus() {
			const resolve = blockedSetStatusResolvers.shift();
			if (resolve) {
				resolve();
			}
		},
		getBlockedSetStatusCount() {
			return blockedSetStatusResolvers.length;
		},
		execCalls,
		setWidgetCalls,
		setFooterCalls,
		notifications,
		ctx,
		getCommandHandler() {
			if (!commandHandler) {
				throw new Error("custom-cmux-status command was not registered");
			}
			return commandHandler;
		},
	};
}

beforeEach(() => {
	installIntervalMocks();
});

afterEach(() => {
	restoreIntervalMocks();
	restoreCmuxEnv();
});

describe("cmux-status extension", () => {
	test("does nothing outside cmux and never touches the TUI widget or footer", async () => {
		delete process.env.CMUX_WORKSPACE_ID;
		delete process.env.CMUX_SURFACE_ID;
		delete process.env.CMUX_PANEL_ID;
		const harness = createHarness();

		await harness.emit("session_start");
		await harness.emit("agent_start");
		harness.emitExtensionEvent(USER_INPUT_WAIT_EVENT, {
			source: "plan-md:request_user_input",
			id: "call-1",
			waiting: true,
		});
		await flushAsyncWork();
		await harness.emit("session_shutdown");

		expect(harness.execCalls.filter((call) => call.command === "cmux")).toEqual([]);
		expect(harness.setWidgetCalls).toEqual([]);
		expect(harness.setFooterCalls).toEqual([]);
	});

	test("does nothing when cmux owner ids are unavailable", async () => {
		process.env.CMUX_WORKSPACE_ID = "workspace:1";
		delete process.env.CMUX_SURFACE_ID;
		delete process.env.CMUX_PANEL_ID;
		const harness = createHarness({ sessionName: "build" });

		await harness.emit("session_start");
		await harness.emit("agent_start");
		harness.emitExtensionEvent(USER_INPUT_WAIT_EVENT, {
			source: "plan-md:request_user_input",
			id: "call-1",
			waiting: true,
		});
		await flushAsyncWork();
		await harness.emit("session_shutdown");

		expect(harness.execCalls.filter((call) => call.command === "cmux")).toEqual([]);
	});

	test("uses an owner-specific key for named sessions", async () => {
		process.env.CMUX_WORKSPACE_ID = "workspace:1";
		process.env.CMUX_SURFACE_ID = "surface:1";
		process.env.CMUX_PANEL_ID = "panel:1";
		const statusKey = buildStatusKey();
		const harness = createHarness({ sessionName: "build" });

		await harness.emit("session_start");

		expect(harness.getWorkspaceStatusText(statusKey)).toBe("π build: Ready");
		expect(
			harness.execCalls.filter((call) => call.command === "cmux" && call.args[0] === "set-status"),
		).toEqual([
			{
				command: "cmux",
				args: buildSetStatusArgs(statusKey, "build", "Ready"),
				options: { cwd: "/tmp/project", timeout: 1500 },
			},
		]);
	});

	test("uses an owner-specific key for unnamed sessions", async () => {
		process.env.CMUX_WORKSPACE_ID = "workspace:1";
		process.env.CMUX_SURFACE_ID = "surface:1";
		process.env.CMUX_PANEL_ID = "panel:1";
		const statusKey = buildStatusKey();
		const harness = createHarness();

		await harness.emit("session_start");

		expect(harness.getWorkspaceStatusText(statusKey)).toBe("π - Ready");
	});

	test("keeps a same-session status from another owner separate", async () => {
		process.env.CMUX_WORKSPACE_ID = "workspace:1";
		process.env.CMUX_SURFACE_ID = "surface:1";
		process.env.CMUX_PANEL_ID = "panel:1";
		const otherKey = formatCmuxStatusKey("surface:surface:2:panel:panel:2");
		const ourKey = buildStatusKey();
		const harness = createHarness({
			initialStatuses: {
				[otherKey]: "π build: Waiting",
			},
			sessionName: "build",
		});

		await harness.emit("session_start");

		expect(harness.getWorkspaceStatusText(otherKey)).toBe("π build: Waiting");
		expect(harness.getWorkspaceStatusText(ourKey)).toBe("π build: Ready");
	});

	test("shows Ready for a named session when the agent finishes", async () => {
		process.env.CMUX_WORKSPACE_ID = "workspace:1";
		process.env.CMUX_SURFACE_ID = "surface:1";
		process.env.CMUX_PANEL_ID = "panel:1";
		const statusKey = buildStatusKey();
		const harness = createHarness({ sessionName: "build" });

		await harness.emit("session_start");
		await harness.emit("agent_start");
		await harness.emit("agent_end");

		expect(harness.getWorkspaceStatusText(statusKey)).toBe("π build: Ready");
		expect(getActiveIntervalCount()).toBe(0);
		expect(
			harness.execCalls.filter((call) => call.command === "cmux" && call.args[0] === "set-status"),
		).toEqual([
			{
				command: "cmux",
				args: buildSetStatusArgs(statusKey, "build", "Ready"),
				options: { cwd: "/tmp/project", timeout: 1500 },
			},
			{
				command: "cmux",
				args: buildSetStatusArgs(statusKey, "build", "Working"),
				options: { cwd: "/tmp/project", timeout: 1500 },
			},
			{
				command: "cmux",
				args: buildSetStatusArgs(statusKey, "build", "Ready"),
				options: { cwd: "/tmp/project", timeout: 1500 },
			},
		]);
	});

	test("sends a cmux notification once per waiting episode", async () => {
		process.env.CMUX_WORKSPACE_ID = "workspace:1";
		process.env.CMUX_SURFACE_ID = "surface:1";
		process.env.CMUX_PANEL_ID = "panel:1";
		const harness = createHarness({ sessionName: "build" });

		await harness.emit("session_start");
		await harness.emit("agent_start");
		harness.emitExtensionEvent(USER_INPUT_WAIT_EVENT, {
			source: "plan-md:request_user_input",
			id: "call-1",
			waiting: true,
		});
		await flushAsyncWork();
		harness.emitExtensionEvent(USER_INPUT_WAIT_EVENT, {
			source: "plan-md:request_user_input",
			id: "call-1",
			waiting: true,
		});
		await flushAsyncWork();
		harness.emitExtensionEvent(USER_INPUT_WAIT_EVENT, {
			source: "plan-md:request_user_input",
			id: "call-1",
			waiting: false,
		});
		await flushAsyncWork();
		harness.emitExtensionEvent(USER_INPUT_WAIT_EVENT, {
			source: "plan-md:request_user_input",
			id: "call-1",
			waiting: true,
		});
		await flushAsyncWork();

		expect(
			harness.execCalls.filter((call) => call.command === "cmux" && call.args[0] === "notify"),
		).toEqual([
			{
				command: "cmux",
				args: [
					"notify",
					"--title",
					formatCmuxStatusText("build", "Waiting"),
					"--body",
					"Waiting for user input.",
					"--workspace",
					"workspace:1",
				],
				options: { cwd: "/tmp/project", timeout: 1500 },
			},
			{
				command: "cmux",
				args: [
					"notify",
					"--title",
					formatCmuxStatusText("build", "Waiting"),
					"--body",
					"Waiting for user input.",
					"--workspace",
					"workspace:1",
				],
				options: { cwd: "/tmp/project", timeout: 1500 },
			},
		]);
	});

	test("keeps syncing statuses when cmux notify fails", async () => {
		process.env.CMUX_WORKSPACE_ID = "workspace:1";
		process.env.CMUX_SURFACE_ID = "surface:1";
		process.env.CMUX_PANEL_ID = "panel:1";
		const statusKey = buildStatusKey();
		const harness = createHarness({ sessionName: "build", notifyFails: true });

		await harness.emit("session_start");
		await harness.emit("agent_start");
		harness.emitExtensionEvent(USER_INPUT_WAIT_EVENT, {
			source: "plan-md:request_user_input",
			id: "call-1",
			waiting: true,
		});
		await flushAsyncWork();
		harness.emitExtensionEvent(USER_INPUT_WAIT_EVENT, {
			source: "plan-md:request_user_input",
			id: "call-1",
			waiting: false,
		});
		await flushAsyncWork();
		await harness.emit("agent_end");

		expect(harness.getWorkspaceStatusText(statusKey)).toBe("π build: Ready");
		expect(
			harness.execCalls.filter((call) => call.command === "cmux" && call.args[0] === "notify").length,
		).toBe(1);
	});

	test("animates Working and stops when leaving Working", async () => {
		process.env.CMUX_WORKSPACE_ID = "workspace:1";
		process.env.CMUX_SURFACE_ID = "surface:1";
		process.env.CMUX_PANEL_ID = "panel:1";
		const statusKey = buildStatusKey();
		const harness = createHarness();

		await harness.emit("session_start");
		await harness.emit("agent_start");
		expect(getActiveIntervalCount()).toBe(1);

		await tickIntervals(2);
		await harness.emit("agent_end");

		expect(getActiveIntervalCount()).toBe(0);
		expect(
			harness.execCalls.filter((call) => call.command === "cmux" && call.args[0] === "set-status"),
		).toEqual([
			{
				command: "cmux",
				args: buildSetStatusArgs(statusKey, undefined, "Ready"),
				options: { cwd: "/tmp/project", timeout: 1500 },
			},
			{
				command: "cmux",
				args: buildSetStatusArgs(statusKey, undefined, "Working", "workspace:1", 0),
				options: { cwd: "/tmp/project", timeout: 1500 },
			},
			{
				command: "cmux",
				args: buildSetStatusArgs(statusKey, undefined, "Working", "workspace:1", 1),
				options: { cwd: "/tmp/project", timeout: 1500 },
			},
			{
				command: "cmux",
				args: buildSetStatusArgs(statusKey, undefined, "Working", "workspace:1", 2),
				options: { cwd: "/tmp/project", timeout: 1500 },
			},
			{
				command: "cmux",
				args: buildSetStatusArgs(statusKey, undefined, "Ready"),
				options: { cwd: "/tmp/project", timeout: 1500 },
			},
		]);
	});

	test("serializes overlapping status updates", async () => {
		process.env.CMUX_WORKSPACE_ID = "workspace:1";
		process.env.CMUX_SURFACE_ID = "surface:1";
		process.env.CMUX_PANEL_ID = "panel:1";
		const statusKey = buildStatusKey();
		const harness = createHarness({ blockedSetStatusTexts: [getCmuxStatusPresentation(undefined, "Working", 0).text] });

		await harness.emit("session_start");
		const startPromise = harness.emit("agent_start");
		await flushAsyncWork();
		expect(harness.getBlockedSetStatusCount()).toBe(1);
		const endPromise = harness.emit("agent_end");
		await flushAsyncWork();
		expect(harness.getWorkspaceStatusText(statusKey)).toBe("π - Ready");

		harness.releaseNextBlockedSetStatus();
		await Promise.all([startPromise, endPromise]);

		expect(harness.getWorkspaceStatusText(statusKey)).toBe("π - Ready");
		expect(
			harness.execCalls.filter((call) => call.command === "cmux" && call.args[0] === "set-status"),
		).toEqual([
			{
				command: "cmux",
				args: buildSetStatusArgs(statusKey, undefined, "Ready"),
				options: { cwd: "/tmp/project", timeout: 1500 },
			},
			{
				command: "cmux",
				args: buildSetStatusArgs(statusKey, undefined, "Working"),
				options: { cwd: "/tmp/project", timeout: 1500 },
			},
			{
				command: "cmux",
				args: buildSetStatusArgs(statusKey, undefined, "Ready"),
				options: { cwd: "/tmp/project", timeout: 1500 },
			},
		]);
	});

	test("waits for in-flight updates before clearing on shutdown", async () => {
		process.env.CMUX_WORKSPACE_ID = "workspace:1";
		process.env.CMUX_SURFACE_ID = "surface:1";
		process.env.CMUX_PANEL_ID = "panel:1";
		const statusKey = buildStatusKey();
		const harness = createHarness({ blockedSetStatusTexts: [getCmuxStatusPresentation(undefined, "Working", 0).text] });

		await harness.emit("session_start");
		const startPromise = harness.emit("agent_start");
		await flushAsyncWork();
		expect(harness.getBlockedSetStatusCount()).toBe(1);

		const shutdownPromise = harness.emit("session_shutdown");
		await flushAsyncWork();
		expect(harness.getWorkspaceStatusText(statusKey)).toBe("π - Ready");

		harness.releaseNextBlockedSetStatus();
		await Promise.all([startPromise, shutdownPromise]);

		expect(harness.getWorkspaceStatusText(statusKey)).toBeNull();
		expect(
			harness.execCalls.filter((call) => call.command === "cmux" && ["set-status", "clear-status"].includes(call.args[0] ?? "")),
		).toEqual([
			{
				command: "cmux",
				args: buildSetStatusArgs(statusKey, undefined, "Ready"),
				options: { cwd: "/tmp/project", timeout: 1500 },
			},
			{
				command: "cmux",
				args: buildSetStatusArgs(statusKey, undefined, "Working"),
				options: { cwd: "/tmp/project", timeout: 1500 },
			},
			{
				command: "cmux",
				args: ["clear-status", statusKey, "--workspace", "workspace:1"],
				options: { cwd: "/tmp/project", timeout: 1500 },
			},
		]);
	});

	test("waits for in-flight updates before clearing when disabled", async () => {
		process.env.CMUX_WORKSPACE_ID = "workspace:1";
		process.env.CMUX_SURFACE_ID = "surface:1";
		process.env.CMUX_PANEL_ID = "panel:1";
		const statusKey = buildStatusKey();
		const harness = createHarness({ blockedSetStatusTexts: [getCmuxStatusPresentation(undefined, "Working", 0).text] });

		await harness.emit("session_start");
		const startPromise = harness.emit("agent_start");
		await flushAsyncWork();
		expect(harness.getBlockedSetStatusCount()).toBe(1);

		const disablePromise = harness.getCommandHandler()("", harness.ctx);
		await flushAsyncWork();
		expect(harness.getWorkspaceStatusText(statusKey)).toBe("π - Ready");

		harness.releaseNextBlockedSetStatus();
		await Promise.all([startPromise, disablePromise]);

		expect(harness.getWorkspaceStatusText(statusKey)).toBeNull();
		expect(harness.notifications).toContainEqual({ message: "cmux status disabled", level: "info" });
	});

	test("clears only this owner key on shutdown and toggle off", async () => {
		process.env.CMUX_WORKSPACE_ID = "workspace:1";
		process.env.CMUX_SURFACE_ID = "surface:1";
		process.env.CMUX_PANEL_ID = "panel:1";
		const statusKey = buildStatusKey();
		const otherKey = formatCmuxStatusKey("surface:surface:2:panel:panel:2");
		const harness = createHarness({
			initialStatuses: {
				[otherKey]: "π build: Waiting",
			},
			sessionName: "build",
		});

		await harness.emit("session_start");
		await harness.getCommandHandler()("", harness.ctx);

		expect(harness.getWorkspaceStatusText(statusKey)).toBeNull();
		expect(harness.getWorkspaceStatusText(otherKey)).toBe("π build: Waiting");
		expect(harness.notifications).toContainEqual({ message: "cmux status disabled", level: "info" });

		await harness.getCommandHandler()("", harness.ctx);
		await harness.emit("session_shutdown");
		expect(harness.getWorkspaceStatusText(otherKey)).toBe("π build: Waiting");
	});
});
