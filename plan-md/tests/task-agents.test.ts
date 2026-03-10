import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import {
	buildTaskAgentRunDetails,
	createTaskAgentDir,
	normalizeTaskAgentTasks,
	registerTaskAgentTools,
	resolveTaskAgentDir,
} from "../task-agents";

describe("normalizeTaskAgentTasks", () => {
	test("sanitizes and deduplicates task ids", () => {
		const normalized = normalizeTaskAgentTasks([
			{ id: "Auth Scan", prompt: "Inspect auth" },
			{ id: "Auth Scan", prompt: "Inspect auth tests" },
			{ prompt: "Inspect docs" },
		]);

		expect(normalized.map((task) => task.id)).toEqual(["auth-scan", "auth-scan-2", "task-3"]);
	});
});

describe("resolveTaskAgentDir", () => {
	test("expands the configured agent dir and falls back to the default path", () => {
		expect(resolveTaskAgentDir({ PI_CODING_AGENT_DIR: "~/custom-agent" })).toBe(
			path.join(os.homedir(), "custom-agent"),
		);
		expect(resolveTaskAgentDir({})).toBe(path.join(os.homedir(), ".pi", "agent"));
	});
});

describe("createTaskAgentDir", () => {
	test("copies locked config files and reuses the rest of the agent directory", async () => {
		const sourceAgentDir = await mkdtemp(path.join(os.tmpdir(), "plan-md-agent-source-"));
		let taskAgentDir: string | null = null;

		try {
			await writeFile(path.join(sourceAgentDir, "auth.json"), '{"openai-codex":{"type":"api_key","key":"secret"}}');
			await writeFile(path.join(sourceAgentDir, "models.json"), '{"models":[]}');
			await writeFile(path.join(sourceAgentDir, "settings.json"), '{"theme":"dark"}');
			await writeFile(path.join(sourceAgentDir, "SYSTEM.md"), "global system prompt");
			await mkdir(path.join(sourceAgentDir, "extensions"), { recursive: true });
			await writeFile(path.join(sourceAgentDir, "extensions", "example.ts"), "export default {}\n");
			await mkdir(path.join(sourceAgentDir, "auth.json.lock"));
			await mkdir(path.join(sourceAgentDir, "settings.json.lock"));

			taskAgentDir = await createTaskAgentDir(sourceAgentDir);
			expect(taskAgentDir).not.toBeNull();
			if (!taskAgentDir) {
				throw new Error("expected an isolated task agent dir");
			}

			expect(await readFile(path.join(taskAgentDir, "auth.json"), "utf8")).toBe(
				'{"openai-codex":{"type":"api_key","key":"secret"}}',
			);
			expect(await readFile(path.join(taskAgentDir, "models.json"), "utf8")).toBe('{"models":[]}');
			expect(await readFile(path.join(taskAgentDir, "settings.json"), "utf8")).toBe('{"theme":"dark"}');
			expect(await readFile(path.join(taskAgentDir, "SYSTEM.md"), "utf8")).toBe("global system prompt");
			expect(await realpath(path.join(taskAgentDir, "extensions"))).toBe(
				await realpath(path.join(sourceAgentDir, "extensions")),
			);
			expect(await readFile(path.join(taskAgentDir, "extensions", "example.ts"), "utf8")).toBe(
				"export default {}\n",
			);

			const taskAgentEntries = await readdir(taskAgentDir);
			expect(taskAgentEntries).not.toContain("auth.json.lock");
			expect(taskAgentEntries).not.toContain("settings.json.lock");
		} finally {
			await rm(sourceAgentDir, { recursive: true, force: true });
			if (taskAgentDir) {
				await rm(taskAgentDir, { recursive: true, force: true });
			}
		}
	});
});

describe("task_agents tool", () => {
	test("uses a separate agent dir for each parallel task", async () => {
		const tempDir = await mkdtemp(path.join(os.tmpdir(), "plan-md-task_agents-tool-"));
		const sourceAgentDir = path.join(tempDir, "source-agent");
		const binDir = path.join(tempDir, "bin");
		const spawnLogPath = path.join(tempDir, "spawn-log.jsonl");
		const originalAuth = '{"openai-codex":{"type":"api_key","key":"secret"}}';
		const originalSettings = '{"theme":"dark"}';
		const originalModels = '{"models":[]}';
		let previousAgentDir: string | undefined;
		let previousPath: string | undefined;
		let previousSpawnLogPath: string | undefined;

		try {
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
const logPath = process.env.TASK_AGENT_LOG_PATH;
const agentDir = process.env.PI_CODING_AGENT_DIR || "";
const read = (name) => {
	const filePath = path.join(agentDir, name);
	return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
};
fs.appendFileSync(logPath, JSON.stringify({
	agentDir,
	auth: read("auth.json"),
	settings: read("settings.json"),
	models: read("models.json"),
}) + "\\n");
setTimeout(() => {
	process.stdout.write(JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: path.basename(agentDir) || "ok" }],
		},
	}) + "\\n");
	process.exit(0);
}, 25);
`,
			);
			await chmod(stubPiPath, 0o755);

			previousAgentDir = process.env.PI_CODING_AGENT_DIR;
			previousPath = process.env.PATH;
			previousSpawnLogPath = process.env.TASK_AGENT_LOG_PATH;
			process.env.PI_CODING_AGENT_DIR = sourceAgentDir;
			process.env.PATH = [binDir, previousPath].filter(Boolean).join(path.delimiter);
			process.env.TASK_AGENT_LOG_PATH = spawnLogPath;

			let taskAgentsTool:
				| {
					execute: (
						toolCallId: string,
						params: { tasks: Array<{ id?: string; prompt: string; cwd?: string }>; concurrency?: number },
						signal?: AbortSignal,
						onUpdate?: (update: unknown) => void,
						ctx?: { cwd: string },
					) => Promise<{ isError?: boolean }>;
				}
				| undefined;

			registerTaskAgentTools(
				{
					registerTool: (tool: { name: string }) => {
						if (tool.name === "task_agents") {
							taskAgentsTool = tool as typeof taskAgentsTool;
						}
					},
				} as any,
				{
					getState: () => ({ active: true }),
					taskAgentsSchema: {},
					steerTaskAgentSchema: {},
				},
			);

			if (!taskAgentsTool) {
				throw new Error("expected task_agents tool to be registered");
			}

			const result = await taskAgentsTool.execute(
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

			const logLines = (await readFile(spawnLogPath, "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { agentDir: string; auth: string; settings: string; models: string });
			expect(logLines).toHaveLength(2);

			const agentDirs = logLines.map((line) => line.agentDir);
			expect(new Set(agentDirs).size).toBe(2);
			expect(agentDirs).not.toContain(sourceAgentDir);
			for (const line of logLines) {
				expect(line.auth).toBe(originalAuth);
				expect(line.settings).toBe(originalSettings);
				expect(line.models).toBe(originalModels);
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
				delete process.env.TASK_AGENT_LOG_PATH;
			} else {
				process.env.TASK_AGENT_LOG_PATH = previousSpawnLogPath;
			}
			await rm(tempDir, { recursive: true, force: true });
		}
	});
});

describe("buildTaskAgentRunDetails", () => {
	test("counts successful tasks", () => {
		const details = buildTaskAgentRunDetails("run-1", [
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
