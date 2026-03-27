import { afterEach, describe, expect, test } from "bun:test";
import cmuxStatusExtension from "../index";
import { formatCmuxStatusKey } from "../utils";

type Handler = (event: any, ctx: any) => Promise<void> | void;

type ExecCall = {
	command: string;
	args: string[];
	options?: {
		cwd?: string;
		timeout?: number;
	};
};

const USER_INPUT_WAIT_EVENT = "pi:waiting-for-user-input";
const ORIGINAL_CMUX_WORKSPACE_ID = process.env.CMUX_WORKSPACE_ID;
const ORIGINAL_CMUX_SURFACE_ID = process.env.CMUX_SURFACE_ID;

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
}

function createHarness(options?: { initialStatuses?: Record<string, string>; sessionName?: string }) {
	const handlers = new Map<string, Handler[]>();
	const eventHandlers = new Map<string, Array<(data: unknown) => void>>();
	const execCalls: ExecCall[] = [];
	const setWidgetCalls: unknown[] = [];
	const setFooterCalls: unknown[] = [];
	const notifications: Array<{ message: string; level?: string }> = [];
	let commandHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
	const statuses = new Map<string, string>(Object.entries(options?.initialStatuses ?? {}));
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
			if (command === "cmux" && args[0] === "list-status") {
				return {
					stdout: JSON.stringify(Array.from(statuses.entries()).map(([key, value]) => ({ key, value }))),
					stderr: "",
					code: 0,
					killed: false,
				};
			}
			if (command === "cmux" && args[0] === "set-status") {
				statuses.set(args[1] ?? "", args[2] ?? "");
				return { stdout: "", stderr: "", code: 0, killed: false };
			}
			if (command === "cmux" && args[0] === "clear-status") {
				statuses.delete(args[1] ?? "");
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
		setSessionName(value: string | undefined) {
			sessionName = value;
		},
		getWorkspaceStatusText(key: string) {
			return statuses.get(key) ?? null;
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

afterEach(() => {
	restoreCmuxEnv();
});

describe("cmux-status extension", () => {
	test("does nothing outside cmux and never touches the TUI widget or footer", async () => {
		delete process.env.CMUX_WORKSPACE_ID;
		delete process.env.CMUX_SURFACE_ID;
		const harness = createHarness();

		await harness.emit("session_start");
		await harness.emit("agent_start");
		harness.emitExtensionEvent(USER_INPUT_WAIT_EVENT, {
			source: "plan-md:request_user_input",
			id: "call-1",
			waiting: true,
		});
		await harness.emit("session_shutdown");

		expect(harness.execCalls.filter((call) => call.command === "cmux")).toEqual([]);
		expect(harness.setWidgetCalls).toEqual([]);
		expect(harness.setFooterCalls).toEqual([]);
	});

	test("uses a session-specific key for named sessions", async () => {
		process.env.CMUX_WORKSPACE_ID = "workspace:1";
		process.env.CMUX_SURFACE_ID = "surface:1";
		const statusKey = formatCmuxStatusKey("build");
		const harness = createHarness({ sessionName: "build" });

		await harness.emit("session_start");
		await harness.emit("session_shutdown");

		expect(harness.execCalls.filter((call) => call.command === "cmux")).toEqual([
			{
				command: "cmux",
				args: ["list-status", "--json", "--workspace", "workspace:1"],
				options: { cwd: "/tmp/project", timeout: 1500 },
			},
			{
				command: "cmux",
				args: ["set-status", statusKey, "π build: Ready", "--workspace", "workspace:1"],
				options: { cwd: "/tmp/project", timeout: 1500 },
			},
			{
				command: "cmux",
				args: ["list-status", "--json", "--workspace", "workspace:1"],
				options: { cwd: "/tmp/project", timeout: 1500 },
			},
			{
				command: "cmux",
				args: ["clear-status", statusKey, "--workspace", "workspace:1"],
				options: { cwd: "/tmp/project", timeout: 1500 },
			},
		]);
	});

	test("uses the shared key for unnamed sessions", async () => {
		process.env.CMUX_WORKSPACE_ID = "workspace:1";
		process.env.CMUX_SURFACE_ID = "surface:1";
		const statusKey = formatCmuxStatusKey(undefined);
		const harness = createHarness();

		await harness.emit("session_start");

		expect(harness.getWorkspaceStatusText(statusKey)).toBe("π - Ready");
	});

	test("does not touch another session's named key", async () => {
		process.env.CMUX_WORKSPACE_ID = "workspace:1";
		process.env.CMUX_SURFACE_ID = "surface:1";
		const otherKey = formatCmuxStatusKey("other");
		const buildKey = formatCmuxStatusKey("build");
		const harness = createHarness({
			initialStatuses: {
				[otherKey]: "π other: Waiting",
			},
			sessionName: "build",
		});

		await harness.emit("session_start");

		expect(harness.getWorkspaceStatusText(otherKey)).toBe("π other: Waiting");
		expect(harness.getWorkspaceStatusText(buildKey)).toBe("π build: Ready");
	});

	test("keeps overwriting when the current status still matches what this instance last wrote", async () => {
		process.env.CMUX_WORKSPACE_ID = "workspace:1";
		process.env.CMUX_SURFACE_ID = "surface:1";
		const statusKey = formatCmuxStatusKey(undefined);
		const harness = createHarness();

		await harness.emit("session_start");
		await harness.emit("agent_start");
		await harness.emit("agent_end");

		expect(
			harness.execCalls.filter((call) => call.command === "cmux" && call.args[0] === "set-status"),
		).toEqual([
			{
				command: "cmux",
				args: ["set-status", statusKey, "π - Ready", "--workspace", "workspace:1"],
				options: { cwd: "/tmp/project", timeout: 1500 },
			},
			{
				command: "cmux",
				args: ["set-status", statusKey, "π - Working", "--workspace", "workspace:1"],
				options: { cwd: "/tmp/project", timeout: 1500 },
			},
			{
				command: "cmux",
				args: ["set-status", statusKey, "π - Ready", "--workspace", "workspace:1"],
				options: { cwd: "/tmp/project", timeout: 1500 },
			},
		]);
	});

	test("only overwrites another surface when the new status has higher priority", async () => {
		process.env.CMUX_WORKSPACE_ID = "workspace:1";
		process.env.CMUX_SURFACE_ID = "surface:1";
		const statusKey = formatCmuxStatusKey("mine");
		const harness = createHarness({
			initialStatuses: {
				[statusKey]: "π other: Waiting",
			},
			sessionName: "mine",
		});

		await harness.emit("session_start");
		await harness.emit("agent_start");
		await harness.emit("tool_execution_start", { toolCallId: "call-1", toolName: "bash" });
		await harness.emit("tool_execution_end", { toolCallId: "call-1", toolName: "bash", isError: true });

		expect(harness.getWorkspaceStatusText(statusKey)).toBe("π mine: Error");
		expect(
			harness.execCalls.filter((call) => call.command === "cmux" && call.args[0] === "set-status"),
		).toEqual([
			{
				command: "cmux",
				args: ["set-status", statusKey, "π mine: Error", "--workspace", "workspace:1"],
				options: { cwd: "/tmp/project", timeout: 1500 },
			},
		]);
	});

	test("switches to Waiting from inter-extension events without setting progress", async () => {
		process.env.CMUX_WORKSPACE_ID = "workspace:1";
		process.env.CMUX_SURFACE_ID = "surface:1";
		const statusKey = formatCmuxStatusKey(undefined);
		const harness = createHarness();

		await harness.emit("session_start");
		await harness.emit("agent_start");
		harness.emitExtensionEvent(USER_INPUT_WAIT_EVENT, {
			source: "plan-md:request_user_input",
			id: "call-1",
			waiting: true,
		});
		harness.emitExtensionEvent(USER_INPUT_WAIT_EVENT, {
			source: "plan-md:request_user_input",
			id: "call-1",
			waiting: false,
		});
		await harness.emit("agent_end");

		expect(
			harness.execCalls.filter((call) => call.command === "cmux" && call.args[0] === "set-progress"),
		).toEqual([]);
		expect(
			harness.execCalls.filter((call) => call.command === "cmux" && call.args[0] === "set-status"),
		).toEqual([
			{
				command: "cmux",
				args: ["set-status", statusKey, "π - Ready", "--workspace", "workspace:1"],
				options: { cwd: "/tmp/project", timeout: 1500 },
			},
			{
				command: "cmux",
				args: ["set-status", statusKey, "π - Working", "--workspace", "workspace:1"],
				options: { cwd: "/tmp/project", timeout: 1500 },
			},
			{
				command: "cmux",
				args: ["set-status", statusKey, "π - Waiting", "--workspace", "workspace:1"],
				options: { cwd: "/tmp/project", timeout: 1500 },
			},
			{
				command: "cmux",
				args: ["set-status", statusKey, "π - Ready", "--workspace", "workspace:1"],
				options: { cwd: "/tmp/project", timeout: 1500 },
			},
		]);
	});

	test("does not clear another surface's status on shutdown or toggle off", async () => {
		process.env.CMUX_WORKSPACE_ID = "workspace:1";
		process.env.CMUX_SURFACE_ID = "surface:1";
		const statusKey = formatCmuxStatusKey("mine");
		const harness = createHarness({ sessionName: "mine" });

		await harness.emit("session_start");
		harness.setWorkspaceStatusText(statusKey, "π other: Waiting");
		await harness.emit("session_shutdown");
		await harness.getCommandHandler()("", harness.ctx);

		expect(
			harness.execCalls.filter((call) => call.command === "cmux" && call.args[0] === "clear-status"),
		).toEqual([]);
		expect(harness.notifications).toContainEqual({ message: "cmux status disabled", level: "info" });
	});
});
