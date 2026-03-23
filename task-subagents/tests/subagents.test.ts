import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import {
	buildSubagentRunDetails,
	createSubagentDir,
	isSubagentExtensionDisabled,
	normalizeSubagentTasks,
	registerSubagentTools,
	resolveSubagentDir,
} from "../subagents";
import type { ReviewedSubagentTask } from "../types";
import {
	resolveSubagentConcurrency,
	resolveSubagentContextMode,
	resolveSubagentThinkingLevel,
	resolveSubagentToolThinkingLevel,
} from "../utils";

describe("normalizeSubagentTasks", () => {
	test("sanitizes and deduplicates task ids", () => {
		const normalized = normalizeSubagentTasks([
			{ id: "Auth Scan", prompt: "Inspect auth" },
			{ id: "Auth Scan", prompt: "Inspect auth tests" },
			{ prompt: "Inspect docs" },
		]);

		expect(normalized.map((task) => task.id)).toEqual(["auth-scan", "auth-scan-2", "task-3"]);
	});
});

describe("resolveSubagentConcurrency", () => {
	test("defaults to two workers", () => {
		expect(resolveSubagentConcurrency(undefined)).toBe(2);
	});

	test("accepts integers in range", () => {
		expect(resolveSubagentConcurrency(1)).toBe(1);
		expect(resolveSubagentConcurrency(4)).toBe(4);
	});

	test("rejects fractional and out-of-range values", () => {
		expect(resolveSubagentConcurrency(1.5)).toBeNull();
		expect(resolveSubagentConcurrency(0)).toBeNull();
		expect(resolveSubagentConcurrency(5)).toBeNull();
	});
});

describe("resolveSubagentThinkingLevel", () => {
	test("accepts supported thinking levels", () => {
		expect(resolveSubagentThinkingLevel("low")).toBe("low");
		expect(resolveSubagentThinkingLevel(" xhigh ")).toBe("xhigh");
		expect(resolveSubagentThinkingLevel("unknown")).toBeUndefined();
	});
});

describe("resolveSubagentToolThinkingLevel", () => {
	test("defaults to the current thinking level and accepts all supported overrides", () => {
		expect(resolveSubagentToolThinkingLevel(undefined, "minimal")).toBe("minimal");
		expect(resolveSubagentToolThinkingLevel("high", "low")).toBe("high");
		expect(resolveSubagentToolThinkingLevel("off", "low")).toBe("off");
		expect(resolveSubagentToolThinkingLevel("minimal", "low")).toBe("minimal");
	});
});

describe("resolveSubagentContextMode", () => {
	test("defaults to fresh and validates context values", () => {
		expect(resolveSubagentContextMode(undefined)).toBe("fresh");
		expect(resolveSubagentContextMode("fork")).toBe("fork");
		expect(resolveSubagentContextMode("other")).toBeNull();
	});
});

describe("resolveSubagentDir", () => {
	test("expands the configured agent dir and falls back to the default path", () => {
		expect(resolveSubagentDir({ PI_CODING_AGENT_DIR: "~/custom-agent" })).toBe(
			path.join(os.homedir(), "custom-agent"),
		);
		expect(resolveSubagentDir({})).toBe(path.join(os.homedir(), ".pi", "agent"));
	});
});

describe("isSubagentExtensionDisabled", () => {
	test("treats 1 and true as disabled", () => {
		expect(isSubagentExtensionDisabled({ PI_TASK_SUBAGENTS_DISABLED: "1" })).toBe(true);
		expect(isSubagentExtensionDisabled({ PI_TASK_SUBAGENTS_DISABLED: "true" })).toBe(true);
		expect(isSubagentExtensionDisabled({ PI_TASK_SUBAGENTS_DISABLED: "0" })).toBe(false);
		expect(isSubagentExtensionDisabled({})).toBe(false);
	});
});

describe("createSubagentDir", () => {
	test("copies locked config files and reuses the rest of the agent directory", async () => {
		const sourceAgentDir = await mkdtemp(path.join(os.tmpdir(), "task-subagents-agent-source-"));
		let subagentDir: string | null = null;

		try {
			await writeFile(path.join(sourceAgentDir, "auth.json"), '{"openai-codex":{"type":"api_key","key":"secret"}}');
			await writeFile(path.join(sourceAgentDir, "models.json"), '{"models":[]}');
			await writeFile(path.join(sourceAgentDir, "settings.json"), '{"theme":"dark"}');
			await writeFile(path.join(sourceAgentDir, "SYSTEM.md"), "global system prompt");
			await mkdir(path.join(sourceAgentDir, "extensions"), { recursive: true });
			await writeFile(path.join(sourceAgentDir, "extensions", "example.ts"), "export default {}\n");
			await mkdir(path.join(sourceAgentDir, "auth.json.lock"));
			await mkdir(path.join(sourceAgentDir, "settings.json.lock"));

			subagentDir = await createSubagentDir(sourceAgentDir);
			expect(subagentDir).not.toBeNull();
			if (!subagentDir) {
				throw new Error("expected an isolated subagent dir");
			}

			expect(await readFile(path.join(subagentDir, "auth.json"), "utf8")).toBe(
				'{"openai-codex":{"type":"api_key","key":"secret"}}',
			);
			expect(await readFile(path.join(subagentDir, "models.json"), "utf8")).toBe('{"models":[]}');
			expect(await readFile(path.join(subagentDir, "settings.json"), "utf8")).toBe('{"theme":"dark"}');
			expect(await readFile(path.join(subagentDir, "SYSTEM.md"), "utf8")).toBe("global system prompt");
			expect(await realpath(path.join(subagentDir, "extensions"))).toBe(
				await realpath(path.join(sourceAgentDir, "extensions")),
			);
			expect(await readFile(path.join(subagentDir, "extensions", "example.ts"), "utf8")).toBe(
				"export default {}\n",
			);

			const subagentEntries = await readdir(subagentDir);
			expect(subagentEntries).not.toContain("auth.json.lock");
			expect(subagentEntries).not.toContain("settings.json.lock");
		} finally {
			await rm(sourceAgentDir, { recursive: true, force: true });
			if (subagentDir) {
				await rm(subagentDir, { recursive: true, force: true });
			}
		}
	});
});

type RegisteredTool = {
	name: string;
	execute: (
		toolCallId: string,
		params: any,
		signal?: AbortSignal,
		onUpdate?: (update: unknown) => void,
		ctx?: any,
	) => Promise<{ isError?: boolean; content: Array<{ type: string; text?: string }>; details?: any }>;
};

async function setupStubPi(tempDir: string) {
	const sourceAgentDir = path.join(tempDir, "source-agent");
	const binDir = path.join(tempDir, "bin");
	const spawnLogPath = path.join(tempDir, "spawn-log.jsonl");
	const originalAuth = '{"openai-codex":{"type":"api_key","key":"secret"}}';
	const originalSettings = '{"theme":"dark"}';
	const originalModels = '{"models":[]}';

	await mkdir(sourceAgentDir, { recursive: true });
	await mkdir(binDir, { recursive: true });
	await writeFile(path.join(sourceAgentDir, "auth.json"), originalAuth);
	await writeFile(path.join(sourceAgentDir, "settings.json"), originalSettings);
	await writeFile(path.join(sourceAgentDir, "models.json"), originalModels);

	const stubPiPath = path.join(binDir, "pi");
	await writeFile(
		stubPiPath,
		`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const logPath = process.env.SUBAGENT_LOG_PATH;
const agentDir = process.env.PI_CODING_AGENT_DIR || "";
const getFlag = (name) => {
	const index = args.indexOf(name);
	return index === -1 ? undefined : args[index + 1];
};
const prompt = getFlag("-p") || "";
const read = (name) => {
	const filePath = path.join(agentDir, name);
	return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
};
if (logPath) {
	fs.appendFileSync(logPath, JSON.stringify({
		agentDir,
		auth: read("auth.json"),
		settings: read("settings.json"),
		models: read("models.json"),
		args,
		model: getFlag("--model") || null,
		thinking: getFlag("--thinking") || null,
		forkSource: getFlag("--fork") || null,
		hasNoSession: args.includes("--no-session"),
		prompt,
		steered: prompt.includes("Steering update from the main agent"),
		subagentsDisabled: process.env.PI_TASK_SUBAGENTS_DISABLED || "",
	}) + "\\n");
}
const output = prompt.includes("Steering update from the main agent") ? "steered output" : path.basename(agentDir) || "ok";
setTimeout(() => {
	process.stdout.write(JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: output }],
		},
	}) + "\\n");
	process.exit(0);
}, 25);
`,
	);
	await chmod(stubPiPath, 0o755);

	return {
		binDir,
		originalAuth,
		originalSettings,
		originalModels,
		sourceAgentDir,
		spawnLogPath,
	};
}

async function readSpawnLog(spawnLogPath: string): Promise<Array<{
	agentDir: string;
	auth: string;
	settings: string;
	models: string;
	args: string[];
	model: string | null;
	thinking: string | null;
	forkSource: string | null;
	hasNoSession: boolean;
	prompt: string;
	steered: boolean;
	subagentsDisabled: string;
}>> {
	try {
		const contents = await readFile(spawnLogPath, "utf8");
		return contents
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === "ENOENT") {
			return [];
		}
		throw error;
	}
}

function registerTools(options?: { thinkingLevel?: string }): Record<string, RegisteredTool> {
	const tools: Record<string, RegisteredTool> = {};
	registerSubagentTools(
		{
			registerTool: (tool: RegisteredTool) => {
				tools[tool.name] = tool;
			},
			getThinkingLevel: () => options?.thinkingLevel ?? "medium",
		} as any,
		{
			subagentsSchema: {},
			steerSubagentSchema: {},
		},
	);
	return tools;
}

function createExecuteContext(
	cwd: string,
	options?: {
		hasUI?: boolean;
		reviewResult?: any;
		availableModels?: Array<{ provider: string; id: string; name?: string; reasoning?: boolean; api?: string }>;
		model?: { provider: string; id: string };
		sessionFile?: string;
	},
) {
	const availableModels = options?.availableModels ?? [];
	return {
		hasUI: options?.hasUI ?? false,
		cwd,
		model: options?.model,
		sessionManager: {
			getSessionFile: () => options?.sessionFile,
		},
		modelRegistry: {
			getAvailable: () => availableModels,
			find: (provider: string, modelId: string) =>
				availableModels.find((model) => model.provider === provider && model.id === modelId),
		},
		ui: {
			custom: async () => options?.reviewResult ?? null,
		},
	};
}

describe("registerSubagentTools", () => {
	test("skips registration when the extension is disabled", () => {
		const previousValue = process.env.PI_TASK_SUBAGENTS_DISABLED;
		try {
			process.env.PI_TASK_SUBAGENTS_DISABLED = "1";
			expect(registerTools()).toEqual({});
		} finally {
			if (previousValue === undefined) {
				delete process.env.PI_TASK_SUBAGENTS_DISABLED;
			} else {
				process.env.PI_TASK_SUBAGENTS_DISABLED = previousValue;
			}
		}
	});
});

describe("subagents tool", () => {
	test("registers subagents and steer_subagent", () => {
		const tools = registerTools();
		expect(Object.keys(tools).sort()).toEqual(["steer_subagent", "subagents"]);
	});

	test("uses a separate agent dir and inherits the current model/thinking in headless mode", async () => {
		const tempDir = await mkdtemp(path.join(os.tmpdir(), "task-subagents-subagents-tool-"));
		const { binDir, originalAuth, originalModels, originalSettings, sourceAgentDir, spawnLogPath } =
			await setupStubPi(tempDir);
		const tools = registerTools({ thinkingLevel: "high" });
		const subagentsTool = tools.subagents;
		let previousAgentDir: string | undefined;
		let previousPath: string | undefined;
		let previousSpawnLogPath: string | undefined;

		try {
			previousAgentDir = process.env.PI_CODING_AGENT_DIR;
			previousPath = process.env.PATH;
			previousSpawnLogPath = process.env.SUBAGENT_LOG_PATH;
			process.env.PI_CODING_AGENT_DIR = sourceAgentDir;
			process.env.PATH = [binDir, previousPath].filter(Boolean).join(path.delimiter);
			process.env.SUBAGENT_LOG_PATH = spawnLogPath;

			const result = await subagentsTool.execute(
				"call-1",
				{
					tasks: [
						{ id: "task-a", prompt: "Inspect A", cwd: tempDir },
						{ id: "task-b", prompt: "Inspect B", cwd: tempDir },
					],
					concurrency: 2,
				},
				undefined,
				undefined,
				createExecuteContext(tempDir, {
					model: { provider: "openai", id: "gpt-5" },
				}),
			);

			expect(result.isError).toBe(false);
			expect(result.content[0]?.text).toContain("Use steer_subagent with runId");
			expect(result.details?.launchedCount).toBe(2);
			expect(result.details?.cancelledCount).toBe(0);

			const logLines = await readSpawnLog(spawnLogPath);
			expect(logLines).toHaveLength(2);

			const agentDirs = logLines.map((line) => line.agentDir);
			expect(new Set(agentDirs).size).toBe(2);
			expect(agentDirs).not.toContain(sourceAgentDir);
			for (const line of logLines) {
				expect(line.auth).toBe(originalAuth);
				expect(line.settings).toBe(originalSettings);
				expect(line.models).toBe(originalModels);
				expect(line.model).toBe("openai/gpt-5");
				expect(line.thinking).toBe("high");
				expect(line.forkSource).toBeNull();
				expect(line.hasNoSession).toBe(true);
				expect(line.subagentsDisabled).toBe("1");
			}
		} finally {
			if (previousAgentDir === undefined) {
				delete process.env.PI_CODING_AGENT_DIR;
			} else {
				process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			}
			if (previousPath === undefined) {
				delete process.env.PATH;
			} else {
				process.env.PATH = previousPath;
			}
			if (previousSpawnLogPath === undefined) {
				delete process.env.SUBAGENT_LOG_PATH;
			} else {
				process.env.SUBAGENT_LOG_PATH = previousSpawnLogPath;
			}
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	test("uses thinking_level as the default launch thinking", async () => {
		const tempDir = await mkdtemp(path.join(os.tmpdir(), "task-subagents-thinking-param-"));
		const { binDir, sourceAgentDir, spawnLogPath } = await setupStubPi(tempDir);
		const tools = registerTools({ thinkingLevel: "low" });
		const subagentsTool = tools.subagents;
		let previousAgentDir: string | undefined;
		let previousPath: string | undefined;
		let previousSpawnLogPath: string | undefined;

		try {
			previousAgentDir = process.env.PI_CODING_AGENT_DIR;
			previousPath = process.env.PATH;
			previousSpawnLogPath = process.env.SUBAGENT_LOG_PATH;
			process.env.PI_CODING_AGENT_DIR = sourceAgentDir;
			process.env.PATH = [binDir, previousPath].filter(Boolean).join(path.delimiter);
			process.env.SUBAGENT_LOG_PATH = spawnLogPath;

			const result = await subagentsTool.execute(
				"call-1",
				{
					tasks: [{ id: "task-a", prompt: "Inspect A", cwd: tempDir }],
					concurrency: 1,
					thinking_level: "minimal",
				},
				undefined,
				undefined,
				createExecuteContext(tempDir, {
					model: { provider: "openai", id: "gpt-5" },
				}),
			);

			expect(result.isError).toBe(false);
			expect(result.details?.tasks[0]).toMatchObject({
				thinkingOverride: undefined,
				launchThinking: "minimal",
			});

			const logLines = await readSpawnLog(spawnLogPath);
			expect(logLines).toHaveLength(1);
			expect(logLines[0]?.thinking).toBe("minimal");
		} finally {
			if (previousAgentDir === undefined) {
				delete process.env.PI_CODING_AGENT_DIR;
			} else {
				process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			}
			if (previousPath === undefined) {
				delete process.env.PATH;
			} else {
				process.env.PATH = previousPath;
			}
			if (previousSpawnLogPath === undefined) {
				delete process.env.SUBAGENT_LOG_PATH;
			} else {
				process.env.SUBAGENT_LOG_PATH = previousSpawnLogPath;
			}
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	test("uses fork context to launch subagents from the current session", async () => {
		const tempDir = await mkdtemp(path.join(os.tmpdir(), "task-subagents-fork-context-"));
		const { binDir, sourceAgentDir, spawnLogPath } = await setupStubPi(tempDir);
		const tools = registerTools({ thinkingLevel: "medium" });
		const subagentsTool = tools.subagents;
		const sessionFile = path.join(tempDir, "main-session.jsonl");
		let previousAgentDir: string | undefined;
		let previousPath: string | undefined;
		let previousSpawnLogPath: string | undefined;

		try {
			previousAgentDir = process.env.PI_CODING_AGENT_DIR;
			previousPath = process.env.PATH;
			previousSpawnLogPath = process.env.SUBAGENT_LOG_PATH;
			process.env.PI_CODING_AGENT_DIR = sourceAgentDir;
			process.env.PATH = [binDir, previousPath].filter(Boolean).join(path.delimiter);
			process.env.SUBAGENT_LOG_PATH = spawnLogPath;

			const result = await subagentsTool.execute(
				"call-1",
				{
					tasks: [{ id: "task-a", prompt: "Inspect A", cwd: tempDir }],
					concurrency: 1,
					context: "fork",
				},
				undefined,
				undefined,
				createExecuteContext(tempDir, {
					model: { provider: "openai", id: "gpt-5" },
					sessionFile,
				}),
			);

			expect(result.isError).toBe(false);
			expect(result.details?.tasks[0]).toMatchObject({
				launchContext: "fork",
				forkSessionFile: sessionFile,
			});

			const logLines = await readSpawnLog(spawnLogPath);
			expect(logLines).toHaveLength(1);
			expect(logLines[0]?.forkSource).toBe(sessionFile);
			expect(logLines[0]?.hasNoSession).toBe(false);
		} finally {
			if (previousAgentDir === undefined) {
				delete process.env.PI_CODING_AGENT_DIR;
			} else {
				process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			}
			if (previousPath === undefined) {
				delete process.env.PATH;
			} else {
				process.env.PATH = previousPath;
			}
			if (previousSpawnLogPath === undefined) {
				delete process.env.SUBAGENT_LOG_PATH;
			} else {
				process.env.SUBAGENT_LOG_PATH = previousSpawnLogPath;
			}
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	test("uses the reviewed launch context from the pre-launch UI", async () => {
		const tempDir = await mkdtemp(path.join(os.tmpdir(), "task-subagents-reviewed-context-"));
		const { binDir, sourceAgentDir, spawnLogPath } = await setupStubPi(tempDir);
		const tools = registerTools();
		const subagentsTool = tools.subagents;
		const sessionFile = path.join(tempDir, "main-session.jsonl");
		let previousAgentDir: string | undefined;
		let previousPath: string | undefined;
		let previousSpawnLogPath: string | undefined;

		try {
			previousAgentDir = process.env.PI_CODING_AGENT_DIR;
			previousPath = process.env.PATH;
			previousSpawnLogPath = process.env.SUBAGENT_LOG_PATH;
			process.env.PI_CODING_AGENT_DIR = sourceAgentDir;
			process.env.PATH = [binDir, previousPath].filter(Boolean).join(path.delimiter);
			process.env.SUBAGENT_LOG_PATH = spawnLogPath;

			const result = await subagentsTool.execute(
				"call-1",
				{
					tasks: [{ id: "task-a", prompt: "Inspect A", cwd: tempDir }],
					concurrency: 1,
				},
				undefined,
				undefined,
				createExecuteContext(tempDir, {
					hasUI: true,
					sessionFile,
					reviewResult: [{ taskId: "task-a", prompt: "Inspect A", cwd: tempDir, launchContext: "fork", launchStatus: "ready" }],
				}),
			);

			expect(result.isError).toBe(false);
			expect(result.details?.tasks[0]).toMatchObject({
				launchContext: "fork",
				forkSessionFile: sessionFile,
			});

			const logLines = await readSpawnLog(spawnLogPath);
			expect(logLines).toHaveLength(1);
			expect(logLines[0]?.forkSource).toBe(sessionFile);
		} finally {
			if (previousAgentDir === undefined) {
				delete process.env.PI_CODING_AGENT_DIR;
			} else {
				process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			}
			if (previousPath === undefined) {
				delete process.env.PATH;
			} else {
				process.env.PATH = previousPath;
			}
			if (previousSpawnLogPath === undefined) {
				delete process.env.SUBAGENT_LOG_PATH;
			} else {
				process.env.SUBAGENT_LOG_PATH = previousSpawnLogPath;
			}
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	test("steer_subagent reuses fork context from the original run", async () => {
		const tempDir = await mkdtemp(path.join(os.tmpdir(), "task-subagents-steer-fork-context-"));
		const { binDir, sourceAgentDir, spawnLogPath } = await setupStubPi(tempDir);
		const tools = registerTools({ thinkingLevel: "medium" });
		const subagentsTool = tools.subagents;
		const steerSubagentTool = tools.steer_subagent;
		const sessionFile = path.join(tempDir, "main-session.jsonl");
		let previousAgentDir: string | undefined;
		let previousPath: string | undefined;
		let previousSpawnLogPath: string | undefined;

		try {
			previousAgentDir = process.env.PI_CODING_AGENT_DIR;
			previousPath = process.env.PATH;
			previousSpawnLogPath = process.env.SUBAGENT_LOG_PATH;
			process.env.PI_CODING_AGENT_DIR = sourceAgentDir;
			process.env.PATH = [binDir, previousPath].filter(Boolean).join(path.delimiter);
			process.env.SUBAGENT_LOG_PATH = spawnLogPath;

			const initialResult = await subagentsTool.execute(
				"call-1",
				{
					tasks: [{ id: "task-a", prompt: "Inspect A", cwd: tempDir }],
					concurrency: 1,
					context: "fork",
				},
				undefined,
				undefined,
				createExecuteContext(tempDir, {
					sessionFile,
				}),
			);

			const rerunResult = await steerSubagentTool.execute(
				"call-2",
				{
					runId: initialResult.details?.runId,
					taskId: "task-a",
					instruction: "Focus on config files.",
				},
				undefined,
				undefined,
				createExecuteContext(tempDir),
			);

			expect(rerunResult.isError).toBe(false);
			expect(rerunResult.details?.tasks[0]).toMatchObject({
				launchContext: "fork",
				forkSessionFile: sessionFile,
			});

			const logLines = await readSpawnLog(spawnLogPath);
			expect(logLines).toHaveLength(2);
			expect(logLines[0]?.forkSource).toBe(sessionFile);
			expect(logLines[1]?.forkSource).toBe(sessionFile);
			expect(logLines[1]?.hasNoSession).toBe(false);
		} finally {
			if (previousAgentDir === undefined) {
				delete process.env.PI_CODING_AGENT_DIR;
			} else {
				process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			}
			if (previousPath === undefined) {
				delete process.env.PATH;
			} else {
				process.env.PATH = previousPath;
			}
			if (previousSpawnLogPath === undefined) {
				delete process.env.SUBAGENT_LOG_PATH;
			} else {
				process.env.SUBAGENT_LOG_PATH = previousSpawnLogPath;
			}
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	test("does not reject a cancelled fork task when ready tasks stay fresh", async () => {
		const tempDir = await mkdtemp(path.join(os.tmpdir(), "task-subagents-cancelled-fork-unsaved-"));
		const { binDir, sourceAgentDir, spawnLogPath } = await setupStubPi(tempDir);
		const tools = registerTools();
		const subagentsTool = tools.subagents;
		let previousAgentDir: string | undefined;
		let previousPath: string | undefined;
		let previousSpawnLogPath: string | undefined;

		try {
			previousAgentDir = process.env.PI_CODING_AGENT_DIR;
			previousPath = process.env.PATH;
			previousSpawnLogPath = process.env.SUBAGENT_LOG_PATH;
			process.env.PI_CODING_AGENT_DIR = sourceAgentDir;
			process.env.PATH = [binDir, previousPath].filter(Boolean).join(path.delimiter);
			process.env.SUBAGENT_LOG_PATH = spawnLogPath;

			const result = await subagentsTool.execute(
				"call-1",
				{
					tasks: [
						{ id: "task-a", prompt: "Inspect A", cwd: tempDir },
						{ id: "task-b", prompt: "Inspect B", cwd: tempDir },
					],
					concurrency: 2,
				},
				undefined,
				undefined,
				createExecuteContext(tempDir, {
					hasUI: true,
					reviewResult: [
						{ taskId: "task-a", prompt: "Inspect A", cwd: tempDir, launchContext: "fresh", launchStatus: "ready" },
						{
							taskId: "task-b",
							prompt: "Inspect B",
							cwd: tempDir,
							launchContext: "fork",
							launchStatus: "cancelled",
							cancellationNote: "skip the forked variant",
						},
					],
				}),
			);

			expect(result.isError).toBe(false);
			expect(result.details?.launchedCount).toBe(1);
			expect(result.details?.cancelledCount).toBe(1);
			expect(result.details?.tasks[1]).toMatchObject({
				status: "cancelled",
				launchContext: "fork",
				cancellationNote: "skip the forked variant",
			});
			expect(await readSpawnLog(spawnLogPath)).toHaveLength(1);
		} finally {
			if (previousAgentDir === undefined) {
				delete process.env.PI_CODING_AGENT_DIR;
			} else {
				process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			}
			if (previousPath === undefined) {
				delete process.env.PATH;
			} else {
				process.env.PATH = previousPath;
			}
			if (previousSpawnLogPath === undefined) {
				delete process.env.SUBAGENT_LOG_PATH;
			} else {
				process.env.SUBAGENT_LOG_PATH = previousSpawnLogPath;
			}
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	test("rejects fork context when the current session is not saved", async () => {
		const tempDir = await mkdtemp(path.join(os.tmpdir(), "task-subagents-fork-missing-session-"));
		const { binDir, sourceAgentDir, spawnLogPath } = await setupStubPi(tempDir);
		const tools = registerTools();
		const subagentsTool = tools.subagents;
		let previousAgentDir: string | undefined;
		let previousPath: string | undefined;
		let previousSpawnLogPath: string | undefined;

		try {
			previousAgentDir = process.env.PI_CODING_AGENT_DIR;
			previousPath = process.env.PATH;
			previousSpawnLogPath = process.env.SUBAGENT_LOG_PATH;
			process.env.PI_CODING_AGENT_DIR = sourceAgentDir;
			process.env.PATH = [binDir, previousPath].filter(Boolean).join(path.delimiter);
			process.env.SUBAGENT_LOG_PATH = spawnLogPath;

			const result = await subagentsTool.execute(
				"call-1",
				{
					tasks: [{ id: "task-a", prompt: "Inspect A", cwd: tempDir }],
					concurrency: 1,
					context: "fork",
				},
				undefined,
				undefined,
				createExecuteContext(tempDir),
			);

			expect(result.isError).toBe(true);
			expect(result.content[0]?.text).toBe('context "fork" requires a saved current session.');
			expect(await readSpawnLog(spawnLogPath)).toEqual([]);
		} finally {
			if (previousAgentDir === undefined) {
				delete process.env.PI_CODING_AGENT_DIR;
			} else {
				process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			}
			if (previousPath === undefined) {
				delete process.env.PATH;
			} else {
				process.env.PATH = previousPath;
			}
			if (previousSpawnLogPath === undefined) {
				delete process.env.SUBAGENT_LOG_PATH;
			} else {
				process.env.SUBAGENT_LOG_PATH = previousSpawnLogPath;
			}
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	test("merges concurrent launch reviews into a single UI session", async () => {
		const tempDir = await mkdtemp(path.join(os.tmpdir(), "task-subagents-merged-review-"));
		const { binDir, sourceAgentDir, spawnLogPath } = await setupStubPi(tempDir);
		const tools = registerTools();
		const subagentsTool = tools.subagents;
		let previousAgentDir: string | undefined;
		let previousPath: string | undefined;
		let previousSpawnLogPath: string | undefined;
		let reviewCalls = 0;
		const sharedContext = {
			hasUI: true,
			cwd: tempDir,
			sessionManager: {
				getSessionFile: () => undefined,
			},
			modelRegistry: {
				getAvailable: () => [],
				find: () => undefined,
			},
			ui: {
				custom: async () => {
					reviewCalls += 1;
					return [
						{ taskId: "task-a", prompt: "Inspect A", cwd: tempDir, launchContext: "fresh", launchStatus: "ready" },
						{ taskId: "task-b", prompt: "Inspect B", cwd: tempDir, launchContext: "fresh", launchStatus: "ready" },
					];
				},
			},
		};

		try {
			previousAgentDir = process.env.PI_CODING_AGENT_DIR;
			previousPath = process.env.PATH;
			previousSpawnLogPath = process.env.SUBAGENT_LOG_PATH;
			process.env.PI_CODING_AGENT_DIR = sourceAgentDir;
			process.env.PATH = [binDir, previousPath].filter(Boolean).join(path.delimiter);
			process.env.SUBAGENT_LOG_PATH = spawnLogPath;

			const [resultA, resultB] = await Promise.all([
				subagentsTool.execute(
					"call-1",
					{
						tasks: [{ id: "task-a", prompt: "Inspect A", cwd: tempDir }],
						concurrency: 1,
					},
					undefined,
					undefined,
					sharedContext as any,
				),
				subagentsTool.execute(
					"call-2",
					{
						tasks: [{ id: "task-b", prompt: "Inspect B", cwd: tempDir }],
						concurrency: 1,
					},
					undefined,
					undefined,
					sharedContext as any,
				),
			]);

			expect(reviewCalls).toBe(1);
			expect(resultA.isError).toBe(false);
			expect(resultB.isError).toBe(false);
			expect(resultA.details?.tasks).toHaveLength(1);
			expect(resultB.details?.tasks).toHaveLength(1);
			expect(resultA.details?.tasks[0]?.taskId).toBe("task-a");
			expect(resultB.details?.tasks[0]?.taskId).toBe("task-b");
			expect(await readSpawnLog(spawnLogPath)).toHaveLength(2);
		} finally {
			if (previousAgentDir === undefined) {
				delete process.env.PI_CODING_AGENT_DIR;
			} else {
				process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			}
			if (previousPath === undefined) {
				delete process.env.PATH;
			} else {
				process.env.PATH = previousPath;
			}
			if (previousSpawnLogPath === undefined) {
				delete process.env.SUBAGENT_LOG_PATH;
			} else {
				process.env.SUBAGENT_LOG_PATH = previousSpawnLogPath;
			}
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	test("merges subagents calls that arrive while the shared review is still open", async () => {
		const tempDir = await mkdtemp(path.join(os.tmpdir(), "task-subagents-merged-review-open-"));
		const { binDir, sourceAgentDir, spawnLogPath } = await setupStubPi(tempDir);
		const tools = registerTools();
		const subagentsTool = tools.subagents;
		let previousAgentDir: string | undefined;
		let previousPath: string | undefined;
		let previousSpawnLogPath: string | undefined;
		let reviewCalls = 0;
		let markReviewStarted: (() => void) | undefined;
		const reviewStarted = new Promise<void>((resolve) => {
			markReviewStarted = resolve;
		});
		let resolveReview: ((tasks: ReviewedSubagentTask[]) => void) | undefined;
		const reviewPromise = new Promise<ReviewedSubagentTask[]>((resolve) => {
			resolveReview = resolve;
		});
		const sharedContext = {
			hasUI: true,
			cwd: tempDir,
			sessionManager: {
				getSessionFile: () => undefined,
			},
			modelRegistry: {
				getAvailable: () => [],
				find: () => undefined,
			},
			ui: {
				custom: async () => {
					reviewCalls += 1;
					markReviewStarted?.();
					return reviewPromise;
				},
			},
		};

		try {
			previousAgentDir = process.env.PI_CODING_AGENT_DIR;
			previousPath = process.env.PATH;
			previousSpawnLogPath = process.env.SUBAGENT_LOG_PATH;
			process.env.PI_CODING_AGENT_DIR = sourceAgentDir;
			process.env.PATH = [binDir, previousPath].filter(Boolean).join(path.delimiter);
			process.env.SUBAGENT_LOG_PATH = spawnLogPath;

			const resultAPromise = subagentsTool.execute(
				"call-1",
				{
					tasks: [{ id: "task-a", prompt: "Inspect A", cwd: tempDir }],
					concurrency: 1,
				},
				undefined,
				undefined,
				sharedContext as any,
			);
			await reviewStarted;

			const resultBPromise = subagentsTool.execute(
				"call-2",
				{
					tasks: [{ id: "task-b", prompt: "Inspect B", cwd: tempDir }],
					concurrency: 1,
				},
				undefined,
				undefined,
				sharedContext as any,
			);

			expect(reviewCalls).toBe(1);
			resolveReview?.([
				{ taskId: "task-a", prompt: "Inspect A", cwd: tempDir, launchContext: "fresh", launchStatus: "ready" },
				{ taskId: "task-b", prompt: "Inspect B", cwd: tempDir, launchContext: "fresh", launchStatus: "ready" },
			]);

			const [resultA, resultB] = await Promise.all([resultAPromise, resultBPromise]);
			expect(reviewCalls).toBe(1);
			expect(resultA.isError).toBe(false);
			expect(resultB.isError).toBe(false);
			expect(resultA.details?.tasks[0]?.taskId).toBe("task-a");
			expect(resultB.details?.tasks[0]?.taskId).toBe("task-b");
			expect(await readSpawnLog(spawnLogPath)).toHaveLength(2);
		} finally {
			if (previousAgentDir === undefined) {
				delete process.env.PI_CODING_AGENT_DIR;
			} else {
				process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			}
			if (previousPath === undefined) {
				delete process.env.PATH;
			} else {
				process.env.PATH = previousPath;
			}
			if (previousSpawnLogPath === undefined) {
				delete process.env.SUBAGENT_LOG_PATH;
			} else {
				process.env.SUBAGENT_LOG_PATH = previousSpawnLogPath;
			}
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	test("cancelling a merged launch review cancels every waiting subagents call", async () => {
		const tempDir = await mkdtemp(path.join(os.tmpdir(), "task-subagents-merged-review-cancel-"));
		const { binDir, sourceAgentDir, spawnLogPath } = await setupStubPi(tempDir);
		const tools = registerTools();
		const subagentsTool = tools.subagents;
		let previousAgentDir: string | undefined;
		let previousPath: string | undefined;
		let previousSpawnLogPath: string | undefined;
		let reviewCalls = 0;
		const sharedContext = {
			hasUI: true,
			cwd: tempDir,
			sessionManager: {
				getSessionFile: () => undefined,
			},
			modelRegistry: {
				getAvailable: () => [],
				find: () => undefined,
			},
			ui: {
				custom: async () => {
					reviewCalls += 1;
					return null;
				},
			},
		};

		try {
			previousAgentDir = process.env.PI_CODING_AGENT_DIR;
			previousPath = process.env.PATH;
			previousSpawnLogPath = process.env.SUBAGENT_LOG_PATH;
			process.env.PI_CODING_AGENT_DIR = sourceAgentDir;
			process.env.PATH = [binDir, previousPath].filter(Boolean).join(path.delimiter);
			process.env.SUBAGENT_LOG_PATH = spawnLogPath;

			const [resultA, resultB] = await Promise.all([
				subagentsTool.execute(
					"call-1",
					{
						tasks: [{ id: "task-a", prompt: "Inspect A", cwd: tempDir }],
						concurrency: 1,
					},
					undefined,
					undefined,
					sharedContext as any,
				),
				subagentsTool.execute(
					"call-2",
					{
						tasks: [{ id: "task-b", prompt: "Inspect B", cwd: tempDir }],
						concurrency: 1,
					},
					undefined,
					undefined,
					sharedContext as any,
				),
			]);

			expect(reviewCalls).toBe(1);
			expect(resultA.isError).toBe(true);
			expect(resultB.isError).toBe(true);
			expect(resultA.content[0]?.text).toBe("Subagent launch cancelled before starting. No child processes were started.");
			expect(resultB.content[0]?.text).toBe("Subagent launch cancelled before starting. No child processes were started.");
			expect(await readSpawnLog(spawnLogPath)).toEqual([]);
		} finally {
			if (previousAgentDir === undefined) {
				delete process.env.PI_CODING_AGENT_DIR;
			} else {
				process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			}
			if (previousPath === undefined) {
				delete process.env.PATH;
			} else {
				process.env.PATH = previousPath;
			}
			if (previousSpawnLogPath === undefined) {
				delete process.env.SUBAGENT_LOG_PATH;
			} else {
				process.env.SUBAGENT_LOG_PATH = previousSpawnLogPath;
			}
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	test("returns early when the pre-launch review is cancelled", async () => {
		const tempDir = await mkdtemp(path.join(os.tmpdir(), "task-subagents-prelaunch-cancel-"));
		const { binDir, sourceAgentDir, spawnLogPath } = await setupStubPi(tempDir);
		const tools = registerTools();
		const subagentsTool = tools.subagents;
		let previousAgentDir: string | undefined;
		let previousPath: string | undefined;
		let previousSpawnLogPath: string | undefined;

		try {
			previousAgentDir = process.env.PI_CODING_AGENT_DIR;
			previousPath = process.env.PATH;
			previousSpawnLogPath = process.env.SUBAGENT_LOG_PATH;
			process.env.PI_CODING_AGENT_DIR = sourceAgentDir;
			process.env.PATH = [binDir, previousPath].filter(Boolean).join(path.delimiter);
			process.env.SUBAGENT_LOG_PATH = spawnLogPath;

			const result = await subagentsTool.execute(
				"call-1",
				{
					tasks: [{ id: "task-a", prompt: "Inspect A", cwd: tempDir }],
					concurrency: 1,
				},
				undefined,
				undefined,
				createExecuteContext(tempDir, { hasUI: true, reviewResult: null }),
			);

			expect(result.isError).toBe(true);
			expect(result.content[0]?.text).toBe("Subagent launch cancelled before starting. No child processes were started.");
			expect(await readSpawnLog(spawnLogPath)).toEqual([]);
		} finally {
			if (previousAgentDir === undefined) {
				delete process.env.PI_CODING_AGENT_DIR;
			} else {
				process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			}
			if (previousPath === undefined) {
				delete process.env.PATH;
			} else {
				process.env.PATH = previousPath;
			}
			if (previousSpawnLogPath === undefined) {
				delete process.env.SUBAGENT_LOG_PATH;
			} else {
				process.env.SUBAGENT_LOG_PATH = previousSpawnLogPath;
			}
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	test("skips cancelled tasks and reports cancellation notes", async () => {
		const tempDir = await mkdtemp(path.join(os.tmpdir(), "task-subagents-selective-cancel-"));
		const { binDir, sourceAgentDir, spawnLogPath } = await setupStubPi(tempDir);
		const tools = registerTools();
		const subagentsTool = tools.subagents;
		let previousAgentDir: string | undefined;
		let previousPath: string | undefined;
		let previousSpawnLogPath: string | undefined;

		try {
			previousAgentDir = process.env.PI_CODING_AGENT_DIR;
			previousPath = process.env.PATH;
			previousSpawnLogPath = process.env.SUBAGENT_LOG_PATH;
			process.env.PI_CODING_AGENT_DIR = sourceAgentDir;
			process.env.PATH = [binDir, previousPath].filter(Boolean).join(path.delimiter);
			process.env.SUBAGENT_LOG_PATH = spawnLogPath;

			const result = await subagentsTool.execute(
				"call-1",
				{
					tasks: [
						{ id: "task-a", prompt: "Inspect A", cwd: tempDir },
						{ id: "task-b", prompt: "Inspect B", cwd: tempDir },
					],
					concurrency: 2,
				},
				undefined,
				undefined,
				createExecuteContext(tempDir, {
					hasUI: true,
					reviewResult: [
						{ taskId: "task-a", prompt: "Inspect A", cwd: tempDir, launchContext: "fresh", launchStatus: "ready" },
						{
							taskId: "task-b",
							prompt: "Inspect B",
							cwd: tempDir,
							launchContext: "fresh",
							launchStatus: "cancelled",
							cancellationNote: "Already covered by task-a",
						},
					],
				}),
			);

			expect(result.isError).toBe(false);
			expect(result.content[0]?.text).toContain("1 cancelled");
			expect(result.content[0]?.text).toContain("Cancellation note: Already covered by task-a");
			expect(result.details?.launchedCount).toBe(1);
			expect(result.details?.cancelledCount).toBe(1);
			expect(result.details?.tasks[1]).toMatchObject({
				status: "cancelled",
				cancellationNote: "Already covered by task-a",
				startedAt: null,
				finishedAt: null,
			});

			const logLines = await readSpawnLog(spawnLogPath);
			expect(logLines).toHaveLength(1);
			expect(logLines[0]?.prompt).toContain("Task ID: task-a");
		} finally {
			if (previousAgentDir === undefined) {
				delete process.env.PI_CODING_AGENT_DIR;
			} else {
				process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			}
			if (previousPath === undefined) {
				delete process.env.PATH;
			} else {
				process.env.PATH = previousPath;
			}
			if (previousSpawnLogPath === undefined) {
				delete process.env.SUBAGENT_LOG_PATH;
			} else {
				process.env.SUBAGENT_LOG_PATH = previousSpawnLogPath;
			}
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	test("inherits the current model and thinking level by default and reuses them for steering", async () => {
		const tempDir = await mkdtemp(path.join(os.tmpdir(), "task-subagents-default-inheritance-"));
		const { binDir, sourceAgentDir, spawnLogPath } = await setupStubPi(tempDir);
		const tools = registerTools({ thinkingLevel: "low" });
		const subagentsTool = tools.subagents;
		const steerSubagentTool = tools.steer_subagent;
		let previousAgentDir: string | undefined;
		let previousPath: string | undefined;
		let previousSpawnLogPath: string | undefined;

		try {
			previousAgentDir = process.env.PI_CODING_AGENT_DIR;
			previousPath = process.env.PATH;
			previousSpawnLogPath = process.env.SUBAGENT_LOG_PATH;
			process.env.PI_CODING_AGENT_DIR = sourceAgentDir;
			process.env.PATH = [binDir, previousPath].filter(Boolean).join(path.delimiter);
			process.env.SUBAGENT_LOG_PATH = spawnLogPath;

			const initialResult = await subagentsTool.execute(
				"call-1",
				{
					tasks: [{ id: "task-a", prompt: "Inspect A", cwd: tempDir }],
					concurrency: 1,
				},
				undefined,
				undefined,
				createExecuteContext(tempDir, {
					hasUI: true,
					model: { provider: "openai", id: "gpt-5" },
					reviewResult: [
						{
							taskId: "task-a",
							prompt: "Inspect A",
							cwd: tempDir,
							launchContext: "fresh",
							launchStatus: "ready",
						},
					],
				}),
			);

			const runId = initialResult.details?.runId;
			expect(runId).toEqual(expect.any(String));
			expect(initialResult.details?.tasks[0]).toMatchObject({
				modelOverride: undefined,
				thinkingOverride: undefined,
				launchModel: "openai/gpt-5",
				launchThinking: "low",
			});

			const rerunResult = await steerSubagentTool.execute(
				"call-2",
				{
					runId,
					taskId: "task-a",
					instruction: "Focus on config files.",
				},
				undefined,
				undefined,
				createExecuteContext(tempDir),
			);

			expect(rerunResult.isError).toBe(false);
			expect(rerunResult.details?.tasks[0]).toMatchObject({
				modelOverride: undefined,
				thinkingOverride: undefined,
				launchModel: "openai/gpt-5",
				launchThinking: "low",
				steeringNotes: ["Focus on config files."],
			});

			const logLines = await readSpawnLog(spawnLogPath);
			expect(logLines).toHaveLength(2);
			expect(logLines[0]?.model).toBe("openai/gpt-5");
			expect(logLines[0]?.thinking).toBe("low");
			expect(logLines[1]?.steered).toBe(true);
			expect(logLines[1]?.model).toBe("openai/gpt-5");
			expect(logLines[1]?.thinking).toBe("low");
		} finally {
			if (previousAgentDir === undefined) {
				delete process.env.PI_CODING_AGENT_DIR;
			} else {
				process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			}
			if (previousPath === undefined) {
				delete process.env.PATH;
			} else {
				process.env.PATH = previousPath;
			}
			if (previousSpawnLogPath === undefined) {
				delete process.env.SUBAGENT_LOG_PATH;
			} else {
				process.env.SUBAGENT_LOG_PATH = previousSpawnLogPath;
			}
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	test("clamps inherited thinking to the selected model before persisting and steering", async () => {
		const tempDir = await mkdtemp(path.join(os.tmpdir(), "task-subagents-thinking-clamp-"));
		const { binDir, sourceAgentDir, spawnLogPath } = await setupStubPi(tempDir);
		const tools = registerTools({ thinkingLevel: "xhigh" });
		const subagentsTool = tools.subagents;
		const steerSubagentTool = tools.steer_subagent;
		let previousAgentDir: string | undefined;
		let previousPath: string | undefined;
		let previousSpawnLogPath: string | undefined;

		try {
			previousAgentDir = process.env.PI_CODING_AGENT_DIR;
			previousPath = process.env.PATH;
			previousSpawnLogPath = process.env.SUBAGENT_LOG_PATH;
			process.env.PI_CODING_AGENT_DIR = sourceAgentDir;
			process.env.PATH = [binDir, previousPath].filter(Boolean).join(path.delimiter);
			process.env.SUBAGENT_LOG_PATH = spawnLogPath;

			const initialResult = await subagentsTool.execute(
				"call-1",
				{
					tasks: [{ id: "task-a", prompt: "Inspect A", cwd: tempDir }],
					concurrency: 1,
				},
				undefined,
				undefined,
				createExecuteContext(tempDir, {
					hasUI: true,
					model: { provider: "openai", id: "gpt-5.2" },
					availableModels: [
						{ provider: "openai", id: "gpt-5.2", name: "GPT-5.2", reasoning: true },
						{ provider: "openai", id: "gpt-5", name: "GPT-5", reasoning: true },
					],
					reviewResult: [
						{
							taskId: "task-a",
							prompt: "Inspect A",
							cwd: tempDir,
							launchContext: "fresh",
							launchStatus: "ready",
							modelOverride: "openai/gpt-5",
						},
					],
				}),
			);

			const runId = initialResult.details?.runId;
			expect(runId).toEqual(expect.any(String));
			expect(initialResult.details?.tasks[0]).toMatchObject({
				modelOverride: "openai/gpt-5",
				thinkingOverride: undefined,
				launchModel: "openai/gpt-5",
				launchThinking: "high",
			});

			const rerunResult = await steerSubagentTool.execute(
				"call-2",
				{
					runId,
					taskId: "task-a",
					instruction: "Double-check the config.",
				},
				undefined,
				undefined,
				createExecuteContext(tempDir, {
					availableModels: [{ provider: "openai", id: "gpt-5", name: "GPT-5", reasoning: true }],
				}),
			);

			expect(rerunResult.isError).toBe(false);
			expect(rerunResult.details?.tasks[0]).toMatchObject({
				launchModel: "openai/gpt-5",
				launchThinking: "high",
				steeringNotes: ["Double-check the config."],
			});

			const logLines = await readSpawnLog(spawnLogPath);
			expect(logLines).toHaveLength(2);
			expect(logLines[0]?.model).toBe("openai/gpt-5");
			expect(logLines[0]?.thinking).toBe("high");
			expect(logLines[1]?.model).toBe("openai/gpt-5");
			expect(logLines[1]?.thinking).toBe("high");
		} finally {
			if (previousAgentDir === undefined) {
				delete process.env.PI_CODING_AGENT_DIR;
			} else {
				process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			}
			if (previousPath === undefined) {
				delete process.env.PATH;
			} else {
				process.env.PATH = previousPath;
			}
			if (previousSpawnLogPath === undefined) {
				delete process.env.SUBAGENT_LOG_PATH;
			} else {
				process.env.SUBAGENT_LOG_PATH = previousSpawnLogPath;
			}
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	test("passes explicit model and thinking overrides to child pi invocations", async () => {
		const tempDir = await mkdtemp(path.join(os.tmpdir(), "task-subagents-overrides-"));
		const { binDir, sourceAgentDir, spawnLogPath } = await setupStubPi(tempDir);
		const tools = registerTools();
		const subagentsTool = tools.subagents;
		let previousAgentDir: string | undefined;
		let previousPath: string | undefined;
		let previousSpawnLogPath: string | undefined;

		try {
			previousAgentDir = process.env.PI_CODING_AGENT_DIR;
			previousPath = process.env.PATH;
			previousSpawnLogPath = process.env.SUBAGENT_LOG_PATH;
			process.env.PI_CODING_AGENT_DIR = sourceAgentDir;
			process.env.PATH = [binDir, previousPath].filter(Boolean).join(path.delimiter);
			process.env.SUBAGENT_LOG_PATH = spawnLogPath;

			const result = await subagentsTool.execute(
				"call-1",
				{
					tasks: [{ id: "task-a", prompt: "Inspect A", cwd: tempDir }],
					concurrency: 1,
				},
				undefined,
				undefined,
				createExecuteContext(tempDir, {
					hasUI: true,
					availableModels: [{ provider: "openai", id: "gpt-5", name: "GPT-5", reasoning: true }],
					reviewResult: [
						{
							taskId: "task-a",
							prompt: "Inspect A",
							cwd: tempDir,
							launchContext: "fresh",
							launchStatus: "ready",
							modelOverride: "openai/gpt-5",
							thinkingOverride: "high",
							},
						],
				}),
			);

			expect(result.isError).toBe(false);
			expect(result.content[0]?.text).toContain("Model override: openai/gpt-5");
			expect(result.content[0]?.text).toContain("Thinking override: high");
			expect(result.details?.tasks[0]).toMatchObject({
				modelOverride: "openai/gpt-5",
				thinkingOverride: "high",
				status: "completed",
			});

			const logLines = await readSpawnLog(spawnLogPath);
			expect(logLines).toHaveLength(1);
			expect(logLines[0]?.model).toBe("openai/gpt-5");
			expect(logLines[0]?.thinking).toBe("high");
		} finally {
			if (previousAgentDir === undefined) {
				delete process.env.PI_CODING_AGENT_DIR;
			} else {
				process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			}
			if (previousPath === undefined) {
				delete process.env.PATH;
			} else {
				process.env.PATH = previousPath;
			}
			if (previousSpawnLogPath === undefined) {
				delete process.env.SUBAGENT_LOG_PATH;
			} else {
				process.env.SUBAGENT_LOG_PATH = previousSpawnLogPath;
			}
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	test("steer_subagent reuses reviewed model and thinking overrides", async () => {
		const tempDir = await mkdtemp(path.join(os.tmpdir(), "task-subagents-steer-tool-"));
		const { binDir, sourceAgentDir, spawnLogPath } = await setupStubPi(tempDir);
		const tools = registerTools();
		const subagentsTool = tools.subagents;
		const steerSubagentTool = tools.steer_subagent;
		let previousAgentDir: string | undefined;
		let previousPath: string | undefined;
		let previousSpawnLogPath: string | undefined;

		try {
			previousAgentDir = process.env.PI_CODING_AGENT_DIR;
			previousPath = process.env.PATH;
			previousSpawnLogPath = process.env.SUBAGENT_LOG_PATH;
			process.env.PI_CODING_AGENT_DIR = sourceAgentDir;
			process.env.PATH = [binDir, previousPath].filter(Boolean).join(path.delimiter);
			process.env.SUBAGENT_LOG_PATH = spawnLogPath;

			const initialResult = await subagentsTool.execute(
				"call-1",
				{
					tasks: [{ id: "task-a", prompt: "Inspect A", cwd: tempDir }],
					concurrency: 1,
				},
				undefined,
				undefined,
				createExecuteContext(tempDir, {
					hasUI: true,
					availableModels: [{ provider: "openai", id: "gpt-5", name: "GPT-5", reasoning: true }],
					reviewResult: [
						{
							taskId: "task-a",
							prompt: "Inspect A",
							cwd: tempDir,
							launchContext: "fresh",
							launchStatus: "ready",
							modelOverride: "openai/gpt-5",
							thinkingOverride: "medium",
							},
						],
				}),
			);

			const runId = initialResult.details?.runId;
			expect(runId).toEqual(expect.any(String));

			const rerunResult = await steerSubagentTool.execute(
				"call-2",
				{
					runId,
					taskId: "task-a",
					instruction: "Focus on config files.",
				},
				undefined,
				undefined,
				createExecuteContext(tempDir),
			);

			expect(rerunResult.isError).toBe(false);
			expect(rerunResult.content[0]?.text).toContain(`Steered task-a in run ${runId}.`);
			expect(rerunResult.content[0]?.text).toContain("steered output");
			expect(rerunResult.details?.tasks[0]).toMatchObject({
				modelOverride: "openai/gpt-5",
				thinkingOverride: "medium",
				steeringNotes: ["Focus on config files."],
			});

			const logLines = await readSpawnLog(spawnLogPath);
			expect(logLines).toHaveLength(2);
			expect(logLines[0]?.model).toBe("openai/gpt-5");
			expect(logLines[0]?.thinking).toBe("medium");
			expect(logLines[1]?.steered).toBe(true);
			expect(logLines[1]?.model).toBe("openai/gpt-5");
			expect(logLines[1]?.thinking).toBe("medium");
		} finally {
			if (previousAgentDir === undefined) {
				delete process.env.PI_CODING_AGENT_DIR;
			} else {
				process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			}
			if (previousPath === undefined) {
				delete process.env.PATH;
			} else {
				process.env.PATH = previousPath;
			}
			if (previousSpawnLogPath === undefined) {
				delete process.env.SUBAGENT_LOG_PATH;
			} else {
				process.env.SUBAGENT_LOG_PATH = previousSpawnLogPath;
			}
			await rm(tempDir, { recursive: true, force: true });
		}
	});
});

describe("buildSubagentRunDetails", () => {
	test("counts completed, failed, and cancelled tasks", () => {
		const details = buildSubagentRunDetails("run-1", [
			{
				taskId: "task-1",
				task: "One",
				cwd: "/tmp",
				status: "completed",
				launchContext: "fresh",
				output: "ok",
				references: [],
				exitCode: 0,
				stderr: "",
				activities: [],
				startedAt: 1,
				finishedAt: 2,
				steeringNotes: [],
			},
			{
				taskId: "task-2",
				task: "Two",
				cwd: "/tmp",
				status: "failed",
				launchContext: "fresh",
				output: "",
				references: [],
				exitCode: 1,
				stderr: "failed",
				activities: [],
				startedAt: 1,
				finishedAt: 2,
				steeringNotes: [],
			},
			{
				taskId: "task-3",
				task: "Three",
				cwd: "/tmp",
				status: "cancelled",
				launchContext: "fresh",
				output: "",
				references: [],
				exitCode: null,
				stderr: "",
				activities: [],
				startedAt: null,
				finishedAt: null,
				steeringNotes: [],
			},
		]);

		expect(details.successCount).toBe(1);
		expect(details.failedCount).toBe(1);
		expect(details.cancelledCount).toBe(1);
		expect(details.launchedCount).toBe(2);
		expect(details.totalCount).toBe(3);
	});
});
