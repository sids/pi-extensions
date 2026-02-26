import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

mock.module("@mariozechner/pi-coding-agent", () => ({
	BorderedLoader: class BorderedLoader {
		onAbort?: () => void;
		constructor(..._args: unknown[]) {}
	},
}));

const { registerPlanModeCommand } = await import("../flow");

const tempDirs: string[] = [];

afterEach(async () => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (!dir) {
			continue;
		}
		await rm(dir, { recursive: true, force: true });
	}
});

function createRegisteredHandler(stateManager: {
	getState: () => any;
	setState: (ctx: any, nextState: any) => void;
	startPlanMode: (ctx: any, options: { originLeafId?: string; planFilePath: string }) => void;
}) {
	let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
	registerPlanModeCommand(
		{
			registerCommand: (_name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) => {
				handler = command.handler;
			},
		} as any,
		{ stateManager },
	);

	if (!handler) {
		throw new Error("Failed to register /plan-mode handler");
	}
	return handler;
}

describe("/plan-mode continue planning", () => {
	test("navigates to saved planning leaf before activating plan mode", async () => {
		const tmpDir = await mkdtemp(path.join(os.tmpdir(), "plan-mode-flow-"));
		tempDirs.push(tmpDir);
		const planFilePath = path.join(tmpDir, "session-1.plan.md");
		await writeFile(planFilePath, "# Existing plan\n", "utf8");

		const startCalls: Array<{ originLeafId?: string; planFilePath: string }> = [];
		let state = {
			version: 1,
			active: false,
			planFilePath,
			lastPlanLeafId: "planning-leaf",
		};
		const handler = createRegisteredHandler({
			getState: () => state,
			setState: (_ctx, nextState) => {
				state = nextState;
			},
			startPlanMode: (_ctx, options) => {
				startCalls.push(options);
			},
		});

		const navigateCalls: Array<{ entryId: string; options: any }> = [];
		await handler("", {
			cwd: tmpDir,
			hasUI: false,
			waitForIdle: async () => {},
			navigateTree: async (entryId: string, options: any) => {
				navigateCalls.push({ entryId, options });
				return { cancelled: false };
			},
			ui: {
				notify: () => {},
			},
			sessionManager: {
				getLeafId: () => "current-leaf",
				getEntries: () => [
					{ id: "user-1", type: "message", message: { role: "user" } },
					{ id: "planning-leaf", type: "message", message: { role: "assistant" } },
				],
				getSessionFile: () => undefined,
				getSessionDir: () => tmpDir,
				getSessionId: () => "session-1",
			},
		});

		expect(navigateCalls).toEqual([
			{
				entryId: "planning-leaf",
				options: {
					summarize: false,
					label: "plan-mode",
				},
			},
		]);
		expect(startCalls).toEqual([
			{
				originLeafId: "current-leaf",
				planFilePath,
			},
		]);
	});

	test("shows an info notification when continue resumes saved planning branch in UI mode", async () => {
		const tmpDir = await mkdtemp(path.join(os.tmpdir(), "plan-mode-flow-"));
		tempDirs.push(tmpDir);
		const planFilePath = path.join(tmpDir, "session-1.plan.md");
		await writeFile(planFilePath, "# Existing plan\n", "utf8");

		const startCalls: Array<{ originLeafId?: string; planFilePath: string }> = [];
		let state = {
			version: 1,
			active: false,
			planFilePath,
			lastPlanLeafId: "planning-leaf",
		};
		const handler = createRegisteredHandler({
			getState: () => state,
			setState: (_ctx, nextState) => {
				state = nextState;
			},
			startPlanMode: (_ctx, options) => {
				startCalls.push(options);
			},
		});

		const navigateCalls: Array<{ entryId: string; options: any }> = [];
		const notifications: Array<{ message: string; level: string }> = [];
		await handler("", {
			cwd: tmpDir,
			hasUI: true,
			waitForIdle: async () => {},
			navigateTree: async (entryId: string, options: any) => {
				navigateCalls.push({ entryId, options });
				return { cancelled: false };
			},
			ui: {
				select: async () => "Continue planning",
				notify: (message: string, level: string) => {
					notifications.push({ message, level });
				},
			},
			sessionManager: {
				getLeafId: () => "current-leaf",
				getEntries: () => [
					{ id: "user-1", type: "message", message: { role: "user" } },
					{ id: "planning-leaf", type: "message", message: { role: "assistant" } },
				],
				getSessionFile: () => undefined,
				getSessionDir: () => tmpDir,
				getSessionId: () => "session-1",
			},
		});

		expect(navigateCalls).toEqual([
			{
				entryId: "planning-leaf",
				options: {
					summarize: false,
					label: "plan-mode",
				},
			},
		]);
		expect(notifications).toContainEqual({
			message: "Resumed previous planning branch.",
			level: "info",
		});
		expect(startCalls).toEqual([
			{
				originLeafId: "current-leaf",
				planFilePath,
			},
		]);
	});

	test("falls back to current leaf when saved planning leaf is unavailable", async () => {
		const tmpDir = await mkdtemp(path.join(os.tmpdir(), "plan-mode-flow-"));
		tempDirs.push(tmpDir);
		const planFilePath = path.join(tmpDir, "session-1.plan.md");
		await writeFile(planFilePath, "# Existing plan\n", "utf8");

		const startCalls: Array<{ originLeafId?: string; planFilePath: string }> = [];
		let state = {
			version: 1,
			active: false,
			planFilePath,
			lastPlanLeafId: "missing-leaf",
		};
		const handler = createRegisteredHandler({
			getState: () => state,
			setState: (_ctx, nextState) => {
				state = nextState;
			},
			startPlanMode: (_ctx, options) => {
				startCalls.push(options);
			},
		});

		const navigateCalls: Array<{ entryId: string; options: any }> = [];
		const notifications: Array<{ message: string; level: string }> = [];
		await handler("", {
			cwd: tmpDir,
			hasUI: false,
			waitForIdle: async () => {},
			navigateTree: async (entryId: string, options: any) => {
				navigateCalls.push({ entryId, options });
				return { cancelled: false };
			},
			ui: {
				notify: (message: string, level: string) => {
					notifications.push({ message, level });
				},
			},
			sessionManager: {
				getLeafId: () => "current-leaf",
				getEntries: () => [{ id: "user-1", type: "message", message: { role: "user" } }],
				getSessionFile: () => undefined,
				getSessionDir: () => tmpDir,
				getSessionId: () => "session-1",
			},
		});

		expect(navigateCalls.length).toBe(0);
		expect(notifications).toContainEqual({
			message: "Saved planning branch is unavailable. Continuing from the current branch tip.",
			level: "warning",
		});
		expect(startCalls).toEqual([
			{
				originLeafId: "current-leaf",
				planFilePath,
			},
		]);
	});
});

describe("/plan-mode start location prompt", () => {
	test("skips empty-vs-current selection when there is no prior history", async () => {
		const tmpDir = await mkdtemp(path.join(os.tmpdir(), "plan-mode-flow-"));
		tempDirs.push(tmpDir);
		const planFilePath = path.join(tmpDir, "session-1.plan.md");

		const startCalls: Array<{ originLeafId?: string; planFilePath: string }> = [];
		let state = {
			version: 1,
			active: false,
			planFilePath,
			lastPlanLeafId: undefined,
		};
		const handler = createRegisteredHandler({
			getState: () => state,
			setState: (_ctx, nextState) => {
				state = nextState;
			},
			startPlanMode: (_ctx, options) => {
				startCalls.push(options);
			},
		});

		const selectCalls: Array<{ prompt: string; choices: string[] }> = [];
		await handler("", {
			cwd: tmpDir,
			hasUI: true,
			waitForIdle: async () => {},
			ui: {
				select: async (prompt: string, choices: string[]) => {
					selectCalls.push({ prompt, choices });
					return "Current branch";
				},
				notify: () => {},
			},
			sessionManager: {
				getLeafId: () => "leaf-1",
				getEntries: () => [{ id: "leaf-1", type: "message", message: { role: "user" } }],
				getSessionFile: () => undefined,
				getSessionDir: () => tmpDir,
				getSessionId: () => "session-1",
			},
		});

		expect(selectCalls).toEqual([]);
		expect(startCalls).toEqual([
			{
				originLeafId: "leaf-1",
				planFilePath,
			},
		]);
	});

	test("offers start-fresh without branch chooser when an existing plan is present", async () => {
		const tmpDir = await mkdtemp(path.join(os.tmpdir(), "plan-mode-flow-"));
		tempDirs.push(tmpDir);
		const planFilePath = path.join(tmpDir, "session-1.plan.md");
		await writeFile(planFilePath, "# Existing plan\n", "utf8");

		const startCalls: Array<{ originLeafId?: string; planFilePath: string }> = [];
		let state = {
			version: 1,
			active: false,
			planFilePath,
			lastPlanLeafId: undefined,
		};
		const handler = createRegisteredHandler({
			getState: () => state,
			setState: (_ctx, nextState) => {
				state = nextState;
			},
			startPlanMode: (_ctx, options) => {
				startCalls.push(options);
			},
		});

		const selectCalls: Array<{ prompt: string; choices: string[] }> = [];
		await handler("", {
			cwd: tmpDir,
			hasUI: true,
			waitForIdle: async () => {},
			ui: {
				select: async (prompt: string, choices: string[]) => {
					selectCalls.push({ prompt, choices });
					return "Start fresh";
				},
				notify: () => {},
			},
			sessionManager: {
				getLeafId: () => "leaf-1",
				getEntries: () => [{ id: "leaf-1", type: "message", message: { role: "user" } }],
				getSessionFile: () => undefined,
				getSessionDir: () => tmpDir,
				getSessionId: () => "session-1",
			},
		});

		expect(selectCalls).toEqual([
			{
				prompt: `Start planning:\nPlan file: ${planFilePath}`,
				choices: ["Continue planning", "Start fresh"],
			},
		]);
		expect(startCalls).toHaveLength(1);
		expect(startCalls[0]).toEqual({
			originLeafId: "leaf-1",
			planFilePath: expect.any(String),
		});
		expect(startCalls[0].planFilePath).not.toBe(planFilePath);
	});
});
