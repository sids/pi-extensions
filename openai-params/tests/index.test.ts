import { afterEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import openAIParamsExtension from "../index";
import {
	OPENAI_PARAMS_COMMAND,
	OPENAI_PARAMS_EVENT_CHANNEL,
	OPENAI_LONG_CACHE_TTL_MS,
	PROMPT_CACHE_RETENTION_EVENT_CHANNEL,
	type OpenAIParamsState,
	type Verbosity,
} from "../utils";

type Handler = (event: any, ctx: any) => Promise<unknown> | unknown;

type ExtensionEvent = {
	channel: string;
	data: unknown;
};

const cleanupPaths: string[] = [];

function createProjectConfig(options?: { fast?: boolean; longCache?: boolean; verbosity?: Verbosity | null }) {
	const baseDir = mkdtempSync(join(tmpdir(), "openai-params-index-"));
	cleanupPaths.push(baseDir);
	const cwd = join(baseDir, "repo");
	const configPath = join(cwd, CONFIG_DIR_NAME, "extensions", "openai-params.json");
	mkdirSync(dirname(configPath), { recursive: true });
	writeFileSync(
		configPath,
		`${JSON.stringify(
			{
				fast: options?.fast ?? false,
				longCache: options?.longCache ?? false,
				verbosity: options?.verbosity ?? null,
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
	return { cwd, configPath };
}

function createHarness(initialCustomResult: OpenAIParamsState | null = null) {
	const handlers = new Map<string, Handler[]>();
	const emittedEvents: ExtensionEvent[] = [];
	const notifications: Array<{ message: string; level?: string }> = [];
	let customResult = initialCustomResult;
	let customCalls = 0;
	let commandHandler: ((args: string, ctx: any) => Promise<void>) | undefined;

	const pi = {
		on(name: string, handler: Handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
			if (name === OPENAI_PARAMS_COMMAND) {
				commandHandler = command.handler;
			}
		},
		events: {
			emit(channel: string, data: unknown) {
				emittedEvents.push({ channel, data });
			},
			on() {
				return () => {};
			},
		},
	} as any;

	openAIParamsExtension(pi);

	const createCtx = (cwd: string, hasUI = false, mode?: string) => ({
		cwd,
		hasUI,
		...(mode ? { mode } : {}),
		model: { provider: "openai", id: "gpt-5.6-sol", api: "openai-responses" },
		ui: {
			custom: async () => {
				customCalls++;
				return customResult;
			},
			notify: (message: string, level?: string) => notifications.push({ message, level }),
		},
	});

	return {
		async emit(name: string, event: any = {}, ctx: any = {}) {
			let result: unknown;
			for (const handler of handlers.get(name) ?? []) {
				result = await handler(event, ctx);
			}
			return result;
		},
		async runCommand(ctx: any, args = "") {
			if (!commandHandler) {
				throw new Error("openai-params command was not registered");
			}
			await commandHandler(args, ctx);
		},
		createCtx,
		emittedEvents,
		notifications,
		getCustomCalls() {
			return customCalls;
		},
		setCustomResult(nextResult: OpenAIParamsState | null) {
			customResult = nextResult;
		},
	};
}

afterEach(() => {
	while (cleanupPaths.length > 0) {
		const path = cleanupPaths.pop();
		if (path) {
			rmSync(path, { recursive: true, force: true });
		}
	}
});

describe("openai-params extension", () => {
	test("emits resolved config when session_start fires for startup and resume", async () => {
		const firstProject = createProjectConfig({ fast: true, longCache: true, verbosity: "medium" });
		const secondProject = createProjectConfig({ fast: false, longCache: false, verbosity: "high" });
		const harness = createHarness();

		await harness.emit("session_start", { reason: "startup" }, harness.createCtx(firstProject.cwd));
		await harness.emit("session_start", { reason: "resume" }, harness.createCtx(secondProject.cwd));

		expect(harness.emittedEvents).toEqual([
			{
				channel: OPENAI_PARAMS_EVENT_CHANNEL,
				data: {
					source: "openai-params",
					cwd: firstProject.cwd,
					fast: true,
					longCache: true,
					verbosity: "medium",
				},
			},
			{
				channel: OPENAI_PARAMS_EVENT_CHANNEL,
				data: {
					source: "openai-params",
					cwd: secondProject.cwd,
					fast: false,
					longCache: false,
					verbosity: "high",
				},
			},
		]);
	});

	test("reports the effective retention when a request is patched", async () => {
		const project = createProjectConfig({ longCache: true });
		const harness = createHarness();
		const ctx = harness.createCtx(project.cwd);
		await harness.emit("session_start", {}, ctx);
		harness.emittedEvents.length = 0;

		const payload = await harness.emit("before_provider_request", { payload: { input: "hi" } }, ctx);

		expect(payload).toEqual({ input: "hi", prompt_cache_retention: "24h" });
		expect(harness.emittedEvents).toEqual([
			{
				channel: PROMPT_CACHE_RETENTION_EVENT_CHANNEL,
				data: {
					source: "openai-params",
					cwd: project.cwd,
					cacheTtlMs: OPENAI_LONG_CACHE_TTL_MS,
					requestStartedAtMs: expect.any(Number),
				},
			},
		]);
	});

	test("does not patch Codex subscription requests", async () => {
		const project = createProjectConfig({ longCache: true });
		const harness = createHarness();
		const ctx = harness.createCtx(project.cwd);
		ctx.model = { provider: "openai-codex", id: "gpt-5.4", api: "openai-codex-responses" };
		await harness.emit("session_start", {}, ctx);
		harness.emittedEvents.length = 0;

		const payload = await harness.emit("before_provider_request", { payload: { input: "hi" } }, ctx);

		expect(payload).toBeUndefined();
		expect(harness.emittedEvents).toEqual([]);
	});

	test("skips the settings screen outside TUI mode", async () => {
		const project = createProjectConfig({ fast: false, verbosity: null });
		const harness = createHarness({ fast: true, longCache: true, verbosity: "low" });
		const ctx = harness.createCtx(project.cwd, true, "rpc");

		await harness.runCommand(ctx);

		expect(harness.getCustomCalls()).toBe(0);
		expect(harness.emittedEvents).toEqual([]);
		expect(harness.notifications).toEqual([
			{
				message: "OpenAI params settings require TUI mode",
				level: "error",
			},
		]);
	});

	test("emits updated state immediately after saving via the command", async () => {
		const project = createProjectConfig({ fast: false, verbosity: null });
		const harness = createHarness({ fast: true, longCache: true, verbosity: "low" });
		const ctx = harness.createCtx(project.cwd, true);

		harness.setCustomResult({ fast: true, longCache: true, verbosity: "high" });
		await harness.runCommand(ctx);

		expect(harness.emittedEvents).toEqual([
			{
				channel: OPENAI_PARAMS_EVENT_CHANNEL,
				data: {
					source: "openai-params",
					cwd: project.cwd,
					fast: true,
					longCache: true,
					verbosity: "high",
				},
			},
		]);
		expect(readFileSync(project.configPath, "utf8")).toContain('"fast": true');
		expect(readFileSync(project.configPath, "utf8")).toContain('"longCache": true');
		expect(readFileSync(project.configPath, "utf8")).toContain('"verbosity": "high"');
		expect(harness.notifications).toEqual([
			{
				message: "Saved OpenAI params: fast on, long cache on, verbosity high",
				level: "info",
			},
		]);
	});
});
