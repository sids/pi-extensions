import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import openAIParamsExtension from "../index";
import {
	OPENAI_PARAMS_COMMAND,
	OPENAI_PARAMS_EVENT_CHANNEL,
	type OpenAIParamsState,
	type Verbosity,
} from "../utils";

type Handler = (event: any, ctx: any) => Promise<void> | void;

type ExtensionEvent = {
	channel: string;
	data: unknown;
};

const cleanupPaths: string[] = [];

function createProjectConfig(options?: { fast?: boolean; verbosity?: Verbosity | null }) {
	const baseDir = mkdtempSync(join(tmpdir(), "openai-params-index-"));
	cleanupPaths.push(baseDir);
	const cwd = join(baseDir, "repo");
	const configPath = join(cwd, ".pi", "extensions", "openai-params.json");
	mkdirSync(dirname(configPath), { recursive: true });
	writeFileSync(
		configPath,
		`${JSON.stringify(
			{
				fast: options?.fast ?? false,
				verbosity: options?.verbosity ?? null,
				supportedModels: ["openai/gpt-5.4", "openai-codex/gpt-5.4"],
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

	const createCtx = (cwd: string, hasUI = false) => ({
		cwd,
		hasUI,
		model: { provider: "openai", id: "gpt-5.4", api: "openai-responses" },
		ui: {
			custom: async () => customResult,
			notify: (message: string, level?: string) => notifications.push({ message, level }),
		},
	});

	return {
		async emit(name: string, event: any = {}, ctx: any = {}) {
			for (const handler of handlers.get(name) ?? []) {
				await handler(event, ctx);
			}
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
	test("emits resolved config on session start and session switch", async () => {
		const firstProject = createProjectConfig({ fast: true, verbosity: "medium" });
		const secondProject = createProjectConfig({ fast: false, verbosity: "high" });
		const harness = createHarness();

		await harness.emit("session_start", {}, harness.createCtx(firstProject.cwd));
		await harness.emit("session_switch", {}, harness.createCtx(secondProject.cwd));

		expect(harness.emittedEvents).toEqual([
			{
				channel: OPENAI_PARAMS_EVENT_CHANNEL,
				data: {
					source: "openai-params",
					cwd: firstProject.cwd,
					fast: true,
					verbosity: "medium",
				},
			},
			{
				channel: OPENAI_PARAMS_EVENT_CHANNEL,
				data: {
					source: "openai-params",
					cwd: secondProject.cwd,
					fast: false,
					verbosity: "high",
				},
			},
		]);
	});

	test("emits updated state immediately after saving via the command", async () => {
		const project = createProjectConfig({ fast: false, verbosity: null });
		const harness = createHarness({ fast: true, verbosity: "low" });
		const ctx = harness.createCtx(project.cwd, true);

		harness.setCustomResult({ fast: true, verbosity: "high" });
		await harness.runCommand(ctx);

		expect(harness.emittedEvents).toEqual([
			{
				channel: OPENAI_PARAMS_EVENT_CHANNEL,
				data: {
					source: "openai-params",
					cwd: project.cwd,
					fast: true,
					verbosity: "high",
				},
			},
		]);
		expect(readFileSync(project.configPath, "utf8")).toContain('"fast": true');
		expect(readFileSync(project.configPath, "utf8")).toContain('"verbosity": "high"');
		expect(harness.notifications).toEqual([
			{
				message: "Saved OpenAI params: fast on, verbosity high",
				level: "info",
			},
		]);
	});
});
