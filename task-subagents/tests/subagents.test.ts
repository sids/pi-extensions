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
import { resolveSubagentConcurrency } from "../utils";

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
		ctx?: { cwd: string },
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
const logPath = process.env.SUBAGENT_LOG_PATH;
const agentDir = process.env.PI_CODING_AGENT_DIR || "";
const promptIndex = process.argv.indexOf("-p");
const prompt = promptIndex === -1 ? "" : process.argv[promptIndex + 1] || "";
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

function registerTools(): Record<string, RegisteredTool> {
	const tools: Record<string, RegisteredTool> = {};
	registerSubagentTools(
		{
			registerTool: (tool: RegisteredTool) => {
				tools[tool.name] = tool;
			},
		} as any,
		{
			subagentsSchema: {},
			steerSubagentSchema: {},
		},
	);
	return tools;
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

	test("uses a separate agent dir for each parallel task and hints steer_subagent", async () => {
		const tempDir = await mkdtemp(path.join(os.tmpdir(), "task-subagents-subagents-tool-"));
		const { binDir, originalAuth, originalModels, originalSettings, sourceAgentDir, spawnLogPath } =
			await setupStubPi(tempDir);
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
				{ cwd: tempDir } as any,
			);

			expect(result.isError).toBe(false);
			expect(result.content[0]?.text).toContain("Use steer_subagent with runId");

			const logLines = (await readFile(spawnLogPath, "utf8"))
				.trim()
				.split("\n")
				.map(
					(line) =>
						JSON.parse(line) as {
							agentDir: string;
							auth: string;
							settings: string;
							models: string;
							subagentsDisabled: string;
						},
				);
			expect(logLines).toHaveLength(2);

			const agentDirs = logLines.map((line) => line.agentDir);
			expect(new Set(agentDirs).size).toBe(2);
			expect(agentDirs).not.toContain(sourceAgentDir);
			for (const line of logLines) {
				expect(line.auth).toBe(originalAuth);
				expect(line.settings).toBe(originalSettings);
				expect(line.models).toBe(originalModels);
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

	test("steer_subagent reruns a prior task with updated naming", async () => {
		const tempDir = await mkdtemp(path.join(os.tmpdir(), "task-subagents-steer-tool-"));
		const { binDir, sourceAgentDir } = await setupStubPi(tempDir);
		const tools = registerTools();
		const subagentsTool = tools.subagents;
		const steerSubagentTool = tools.steer_subagent;
		let previousAgentDir: string | undefined;
		let previousPath: string | undefined;

		try {
			previousAgentDir = process.env.PI_CODING_AGENT_DIR;
			previousPath = process.env.PATH;
			process.env.PI_CODING_AGENT_DIR = sourceAgentDir;
			process.env.PATH = [binDir, previousPath].filter(Boolean).join(path.delimiter);

			const initialResult = await subagentsTool.execute(
				"call-1",
				{
					tasks: [{ id: "task-a", prompt: "Inspect A", cwd: tempDir }],
					concurrency: 1,
				},
				undefined,
				undefined,
				{ cwd: tempDir } as any,
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
				{ cwd: tempDir } as any,
			);

			expect(rerunResult.isError).toBe(false);
			expect(rerunResult.content[0]?.text).toContain(`Steered task-a in run ${runId}.`);
			expect(rerunResult.content[0]?.text).toContain("steered output");
			expect(rerunResult.details?.tasks[0]?.steeringNotes).toEqual(["Focus on config files."]);
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
			await rm(tempDir, { recursive: true, force: true });
		}
	});
});

describe("buildSubagentRunDetails", () => {
	test("counts successful tasks", () => {
		const details = buildSubagentRunDetails("run-1", [
			{
				taskId: "task-1",
				task: "One",
				cwd: "/tmp",
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
				output: "",
				references: [],
				exitCode: 1,
				stderr: "failed",
				activities: [],
				startedAt: 1,
				finishedAt: 2,
				steeringNotes: [],
			},
		]);

		expect(details.successCount).toBe(1);
		expect(details.totalCount).toBe(2);
	});
});
