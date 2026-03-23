import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { Dirent } from "node:fs";
import { copyFile, mkdtemp, readdir, rm, stat, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { AgentMessage, AgentToolResult } from "@mariozechner/pi-agent-core";
import { supportsXhigh, type TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createInitialReviewedSubagentTasks, runSubagentLaunchReview } from "./launch-tui";
import type {
	NormalizedSubagentTask,
	ReviewedSubagentTask,
	SubagentActivity,
	SubagentActivityKind,
	SubagentProgressDetails,
	SubagentRunDetails,
	SubagentRunRecord,
	SubagentTask,
	SubagentTaskProgress,
	SubagentTaskResult,
	SubagentThinkingLevel,
} from "./types";
import { resolveSubagentConcurrency } from "./utils";

const require = createRequire(import.meta.url);

function requirePiTui() {
	try {
		return require("@mariozechner/pi-tui");
	} catch (error) {
		const code = (error as { code?: string }).code;
		if (code !== "MODULE_NOT_FOUND") {
			throw error;
		}
		return require(path.join(os.homedir(), ".bun", "install", "global", "node_modules", "@mariozechner", "pi-tui"));
	}
}

function createText(text: string) {
	const { Text } = requirePiTui() as {
		Text: new (text: string, x: number, y: number) => unknown;
	};
	return new Text(text, 0, 0);
}

const SUBAGENT_PREVIEW_LIMIT = 4;
// Each subagent gets its own agent dir copy for auth/settings/models so concurrent
// `pi --no-session` startup does not contend on global lock files.
const SUBAGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
// Child pi processes inherit this to prevent recursive subagent delegation.
const SUBAGENT_EXTENSION_DISABLED_ENV = "PI_TASK_SUBAGENTS_DISABLED";
const SUBAGENT_DIR_COPIED_FILES = new Set(["auth.json", "models.json", "settings.json"]);
const SUBAGENT_DIR_SKIPPED_FILES = new Set(["auth.json.lock", "models.json.lock", "settings.json.lock"]);

export function resolveSubagentDir(env: NodeJS.ProcessEnv = process.env): string {
	const value = env[SUBAGENT_DIR_ENV]?.trim();
	if (!value) {
		return path.join(os.homedir(), ".pi", "agent");
	}
	if (value === "~") {
		return os.homedir();
	}
	if (value.startsWith("~/")) {
		return path.join(os.homedir(), value.slice(2));
	}
	return value;
}

export function isSubagentExtensionDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env[SUBAGENT_EXTENSION_DISABLED_ENV]?.trim().toLowerCase();
	return value === "1" || value === "true";
}

function getAgentDirSymlinkType(isDirectory: boolean): "file" | "dir" | "junction" {
	if (!isDirectory) {
		return "file";
	}
	return process.platform === "win32" ? "junction" : "dir";
}

export async function createSubagentDir(sourceAgentDir: string = resolveSubagentDir()): Promise<string | null> {
	const resolvedSourceAgentDir = path.resolve(sourceAgentDir);
	let entries: Dirent[];
	try {
		entries = await readdir(resolvedSourceAgentDir, { withFileTypes: true });
	} catch {
		return null;
	}

	const tempAgentDir = await mkdtemp(path.join(os.tmpdir(), "pi-task-subagents-agent-"));
	for (const entry of entries) {
		if (SUBAGENT_DIR_SKIPPED_FILES.has(entry.name)) {
			continue;
		}

		const sourcePath = path.join(resolvedSourceAgentDir, entry.name);
		const targetPath = path.join(tempAgentDir, entry.name);
		if (SUBAGENT_DIR_COPIED_FILES.has(entry.name)) {
			await copyFile(sourcePath, targetPath);
			continue;
		}

		const sourceStats = entry.isSymbolicLink() ? await stat(sourcePath) : undefined;
		const isDirectory = entry.isDirectory() || sourceStats?.isDirectory() === true;
		if (isDirectory) {
			await symlink(sourcePath, targetPath, getAgentDirSymlinkType(true));
			continue;
		}

		await copyFile(sourcePath, targetPath);
	}

	return tempAgentDir;
}

async function removeSubagentDir(agentDir: string | null | undefined) {
	if (!agentDir) {
		return;
	}
	await rm(agentDir, { recursive: true, force: true });
}

function getAssistantText(message: AgentMessage): string {
	if (message.role !== "assistant") {
		return "";
	}

	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

function extractReferences(text: string): string[] {
	const urls = new Set<string>();
	for (const match of text.matchAll(/https?:\/\/\S+/g)) {
		urls.add(match[0].replace(/[),.;]+$/, ""));
	}
	return Array.from(urls);
}

async function runWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	runner: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) {
		return [];
	}

	const normalizedConcurrency = Number.isFinite(concurrency) ? Math.floor(concurrency) : 1;
	const limit = Math.max(1, Math.min(normalizedConcurrency, items.length));
	const results = new Array<TOut>(items.length);
	let nextIndex = 0;

	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const index = nextIndex++;
			if (index >= items.length) {
				return;
			}
			results[index] = await runner(items[index], index);
		}
	});

	await Promise.all(workers);
	return results;
}

function getMessageText(message: AgentMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

export function createSubagentRunId(): string {
	return `run-${randomBytes(4).toString("hex")}`;
}

function normalizeSubagentTaskId(rawId: string | undefined, index: number, used: Set<string>): string {
	const fallback = `task-${index + 1}`;
	const base =
		rawId
			?.trim()
			.toLowerCase()
			.replace(/[^a-z0-9_-]+/g, "-")
			.replace(/-+/g, "-")
			.replace(/^[-_]+|[-_]+$/g, "") || fallback;

	let id = base;
	let suffix = 2;
	while (used.has(id)) {
		id = `${base}-${suffix}`;
		suffix += 1;
	}

	used.add(id);
	return id;
}

export function normalizeSubagentTasks(tasks: SubagentTask[]): NormalizedSubagentTask[] {
	const used = new Set<string>();
	return tasks.map((task, index) => ({
		id: normalizeSubagentTaskId(task.id, index, used),
		prompt: task.prompt,
		cwd: task.cwd,
	}));
}

function summarizeSnippet(text: string, maxLength: number = 120): string {
	const singleLine = text.replace(/\s+/g, " ").trim();
	if (!singleLine) {
		return "";
	}
	if (singleLine.length <= maxLength) {
		return singleLine;
	}
	return `${singleLine.slice(0, maxLength - 3)}...`;
}

function indentMultiline(text: string, indent: string): string[] {
	const normalized = text.replace(/\r\n/g, "\n");
	return normalized.split("\n").map((line) => `${indent}${line}`);
}

function formatToolCallArguments(argumentsValue: unknown): string {
	if (argumentsValue === undefined) {
		return "";
	}

	let serialized = "";
	try {
		serialized = JSON.stringify(argumentsValue);
	} catch {
		serialized = String(argumentsValue);
	}

	const preview = summarizeSnippet(serialized, 90);
	return preview ? ` ${preview}` : "";
}

function formatSubagentActivity(activity: SubagentActivity): string {
	switch (activity.kind) {
		case "tool":
			return `→ ${activity.text}`;
		case "assistant":
			return `✎ ${activity.text}`;
		case "toolResult":
			return `↳ ${activity.text}`;
		case "stderr":
			return `! ${activity.text}`;
		default:
			return `• ${activity.text}`;
	}
}

function cloneSubagentProgress(tasks: SubagentTaskProgress[]): SubagentTaskProgress[] {
	return tasks.map((task) => ({ ...task }));
}

function buildProgressCounts(tasks: SubagentTaskProgress[]) {
	const succeededCount = tasks.filter((task) => task.status === "completed").length;
	const failedCount = tasks.filter((task) => task.status === "failed").length;
	const cancelledCount = tasks.filter((task) => task.status === "cancelled").length;
	return {
		launchedCount: tasks.filter((task) => task.status !== "cancelled").length,
		succeededCount,
		failedCount,
		cancelledCount,
		completed: succeededCount + failedCount + cancelledCount,
	};
}

function buildSubagentProgressDetails(runId: string, tasks: SubagentTaskProgress[]): SubagentProgressDetails {
	const counts = buildProgressCounts(tasks);
	return {
		runId,
		completed: counts.completed,
		total: tasks.length,
		launchedCount: counts.launchedCount,
		succeededCount: counts.succeededCount,
		failedCount: counts.failedCount,
		cancelledCount: counts.cancelledCount,
		tasks: cloneSubagentProgress(tasks),
	};
}

function formatProgressContext(task: Pick<SubagentTaskProgress, "prompt" | "status" | "latestActivity" | "cancellationNote">): string {
	if (task.status === "cancelled") {
		if (task.cancellationNote?.trim()) {
			return `cancelled — ${summarizeSnippet(task.cancellationNote, 100)}`;
		}
		return "cancelled before launch";
	}
	if (task.latestActivity?.trim()) {
		return task.latestActivity;
	}
	return summarizeSnippet(task.prompt, 100);
}

function buildSubagentProgressText(details: SubagentProgressDetails): string {
	const lines: string[] = [
		`Subagent run ${details.runId}: ${details.completed}/${details.total} resolved (${details.succeededCount} completed, ${details.failedCount} failed, ${details.cancelledCount} cancelled)`,
	];
	for (const task of details.tasks) {
		const status = task.status.padEnd(9, " ");
		const latest = formatProgressContext(task);
		const suffix = latest ? ` — ${latest}` : "";
		lines.push(`[${task.taskId}] ${status}${suffix}`);
	}
	return lines.join("\n");
}

type PreparedSubagentTask = ReviewedSubagentTask & {
	launchModel?: string;
	launchThinking?: SubagentThinkingLevel;
};

type RunnableSubagentTask = PreparedSubagentTask;

const SUBAGENT_THINKING_LEVEL_ORDER: SubagentThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

function buildCurrentSubagentModelId(model: { provider: string; id: string } | undefined): string | undefined {
	if (!model) {
		return undefined;
	}
	return `${model.provider}/${model.id}`;
}

function parseSubagentModelId(modelId: string | undefined): { provider: string; id: string } | undefined {
	if (!modelId) {
		return undefined;
	}
	const separatorIndex = modelId.indexOf("/");
	if (separatorIndex === -1) {
		return undefined;
	}
	return {
		provider: modelId.slice(0, separatorIndex),
		id: modelId.slice(separatorIndex + 1),
	};
}

function getAvailableSubagentThinkingLevels(model: { id: string; api?: string; reasoning?: boolean } | undefined): SubagentThinkingLevel[] {
	if (!model?.reasoning) {
		return ["off"];
	}
	return supportsXhigh(model as Parameters<typeof supportsXhigh>[0])
		? [...SUBAGENT_THINKING_LEVEL_ORDER]
		: SUBAGENT_THINKING_LEVEL_ORDER.slice(0, -1);
}

function clampSubagentThinkingLevel(
	level: SubagentThinkingLevel,
	availableLevels: SubagentThinkingLevel[],
): SubagentThinkingLevel {
	if (availableLevels.includes(level)) {
		return level;
	}

	const available = new Set(availableLevels);
	const requestedIndex = SUBAGENT_THINKING_LEVEL_ORDER.indexOf(level);
	if (requestedIndex === -1) {
		return availableLevels[0] ?? "off";
	}
	for (let index = requestedIndex; index < SUBAGENT_THINKING_LEVEL_ORDER.length; index++) {
		const candidate = SUBAGENT_THINKING_LEVEL_ORDER[index]!;
		if (available.has(candidate)) {
			return candidate;
		}
	}
	for (let index = requestedIndex - 1; index >= 0; index--) {
		const candidate = SUBAGENT_THINKING_LEVEL_ORDER[index]!;
		if (available.has(candidate)) {
			return candidate;
		}
	}
	return availableLevels[0] ?? "off";
}

function resolvePreparedSubagentThinking(
	modelRegistry: { find: (provider: string, modelId: string) => { id: string; api?: string; reasoning?: boolean } | undefined },
	launchModel: string | undefined,
	requestedThinking: SubagentThinkingLevel | undefined,
): SubagentThinkingLevel | undefined {
	if (!requestedThinking) {
		return undefined;
	}
	const parsedModelId = parseSubagentModelId(launchModel);
	if (!parsedModelId) {
		return requestedThinking;
	}
	const model = modelRegistry.find(parsedModelId.provider, parsedModelId.id);
	if (!model) {
		return requestedThinking;
	}
	return clampSubagentThinkingLevel(requestedThinking, getAvailableSubagentThinkingLevels(model));
}

function prepareSubagentTasks(
	tasks: ReviewedSubagentTask[],
	defaults: {
		model?: string;
		thinking?: SubagentThinkingLevel;
	},
	modelRegistry: { find: (provider: string, modelId: string) => { id: string; api?: string; reasoning?: boolean } | undefined },
): PreparedSubagentTask[] {
	return tasks.map((task) => {
		const launchModel = task.modelOverride ?? defaults.model;
		return {
			...task,
			launchModel,
			launchThinking: resolvePreparedSubagentThinking(
				modelRegistry,
				launchModel,
				task.thinkingOverride ?? defaults.thinking,
			),
		};
	});
}

type RunSubagentTaskOptions = {
	signal?: AbortSignal;
	onActivity?: (activity: SubagentActivity) => void;
	steeringInstruction?: string;
	previousOutput?: string;
	steeringNotes?: string[];
};

async function runSubagentTask(
	task: RunnableSubagentTask,
	options?: RunSubagentTaskOptions,
): Promise<SubagentTaskResult> {
	const promptParts = [
		"You are a focused research subagent helping the main coding agent.",
		"Stay read-only. Do not edit files.",
		`Task ID: ${task.taskId}`,
		`Task: ${task.prompt}`,
		"Return markdown with the sections: Summary and References.",
		"In References, include file paths, symbols, and URLs you relied on. If none, write 'None'.",
	];

	if (options?.steeringInstruction?.trim()) {
		promptParts.push(`Steering update from the main agent:\n${options.steeringInstruction.trim()}`);
		if (options.previousOutput?.trim()) {
			promptParts.push(`Most recent output for this task:\n${options.previousOutput.trim()}`);
		}
	}

	const prompt = promptParts.join("\n\n");
	const args = ["--mode", "json", "--no-session"];
	if (task.launchModel) {
		args.push("--model", task.launchModel);
	}
	if (task.launchThinking) {
		args.push("--thinking", task.launchThinking);
	}
	args.push("-p", prompt);

	let agentDir: string | null = null;
	try {
		agentDir = await createSubagentDir();
	} catch {
		agentDir = null;
	}
	const env = {
		...process.env,
		[SUBAGENT_EXTENSION_DISABLED_ENV]: "1",
		...(agentDir ? { [SUBAGENT_DIR_ENV]: agentDir } : {}),
	};
	const startedAt = Date.now();
	const activities: SubagentActivity[] = [];
	const maxActivities = 120;

	const recordActivity = (kind: SubagentActivityKind, text: string) => {
		const normalized = summarizeSnippet(text, 180);
		if (!normalized) {
			return;
		}
		const activity: SubagentActivity = {
			kind,
			text: normalized,
			timestamp: Date.now(),
		};
		activities.push(activity);
		if (activities.length > maxActivities) {
			activities.shift();
		}
		options?.onActivity?.(activity);
	};

	recordActivity("status", "started");

	return new Promise<SubagentTaskResult>((resolve) => {
		const child = spawn("pi", args, {
			cwd: task.cwd,
			env,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdoutBuffer = "";
		let stderr = "";
		const assistantOutputs: string[] = [];
		let aborted = false;
		let abortRequested = false;
		let closed = false;
		let resolved = false;
		let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

		const abortListener = () => {
			if (abortRequested || closed) {
				return;
			}
			abortRequested = true;
			aborted = true;
			recordActivity("status", "aborting");
			try {
				child.kill("SIGTERM");
			} catch {
				return;
			}

			forceKillTimer = setTimeout(() => {
				if (closed) {
					return;
				}
				recordActivity("status", "forcing termination");
				try {
					child.kill("SIGKILL");
				} catch {
					// Process may already be gone.
				}
			}, 3000);
		};

		const cleanupAbortHandling = () => {
			if (forceKillTimer) {
				clearTimeout(forceKillTimer);
				forceKillTimer = undefined;
			}
			if (options?.signal) {
				options.signal.removeEventListener("abort", abortListener);
			}
			void removeSubagentDir(agentDir).catch(() => {
				// Best-effort cleanup for per-task agent dirs.
			});
		};

		const resolveOnce = (result: SubagentTaskResult) => {
			if (resolved) {
				return;
			}
			resolved = true;
			resolve(result);
		};

		const processLine = (line: string) => {
			if (!line.trim()) {
				return;
			}

			let event: unknown;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}

			const parsed = event as { type?: string; message?: AgentMessage };
			if (parsed.type === "message_end" && parsed.message) {
				if (parsed.message.role !== "assistant") {
					return;
				}

				for (const part of parsed.message.content) {
					if (part.type === "toolCall") {
						const name = part.name || "unknown_tool";
						recordActivity("tool", `${name}${formatToolCallArguments(part.arguments)}`);
						continue;
					}

					if (part.type === "text") {
						recordActivity("assistant", part.text);
					}
				}

				const text = getAssistantText(parsed.message);
				if (text.length > 0) {
					assistantOutputs.push(text);
				}
			}

			if (parsed.type === "tool_result_end" && parsed.message) {
				const toolText = getMessageText(parsed.message);
				if (toolText) {
					recordActivity("toolResult", toolText);
				}
			}
		};

		child.stdout.on("data", (chunk) => {
			stdoutBuffer += chunk.toString();
			const lines = stdoutBuffer.split("\n");
			stdoutBuffer = lines.pop() ?? "";
			for (const line of lines) {
				processLine(line);
			}
		});

		child.stderr.on("data", (chunk) => {
			const text = chunk.toString();
			stderr += text;
			for (const line of text.split("\n")) {
				if (line.trim()) {
					recordActivity("stderr", line);
				}
			}
		});

		child.on("close", (code) => {
			closed = true;
			cleanupAbortHandling();
			if (stdoutBuffer.trim()) {
				processLine(stdoutBuffer);
			}

			const exitCode = code ?? 1;
			const status = aborted || exitCode !== 0 ? "failed" : "completed";
			recordActivity("status", `finished with exit code ${exitCode}`);
			const output = assistantOutputs[assistantOutputs.length - 1] ?? "";
			resolveOnce({
				taskId: task.taskId,
				task: task.prompt,
				cwd: task.cwd,
				status,
				modelOverride: task.modelOverride,
				thinkingOverride: task.thinkingOverride,
				launchModel: task.launchModel,
				launchThinking: task.launchThinking,
				cancellationNote: undefined,
				output,
				references: extractReferences(output),
				exitCode,
				stderr: aborted ? "aborted" : stderr,
				activities,
				startedAt,
				finishedAt: Date.now(),
				steeringNotes: options?.steeringNotes ?? [],
			});
		});

		child.on("error", (error) => {
			cleanupAbortHandling();
			recordActivity("stderr", error.message);
			resolveOnce({
				taskId: task.taskId,
				task: task.prompt,
				cwd: task.cwd,
				status: "failed",
				modelOverride: task.modelOverride,
				thinkingOverride: task.thinkingOverride,
				launchModel: task.launchModel,
				launchThinking: task.launchThinking,
				cancellationNote: undefined,
				output: "",
				references: [],
				exitCode: 1,
				stderr: error.message,
				activities,
				startedAt,
				finishedAt: Date.now(),
				steeringNotes: options?.steeringNotes ?? [],
			});
		});

		if (options?.signal) {
			if (options.signal.aborted) {
				abortListener();
			} else {
				options.signal.addEventListener("abort", abortListener, { once: true });
			}
		}
	});
}

function createCancelledSubagentTaskResult(task: PreparedSubagentTask): SubagentTaskResult {
	const activityText = task.cancellationNote?.trim()
		? `cancelled before launch: ${task.cancellationNote.trim()}`
		: "cancelled before launch";
	return {
		taskId: task.taskId,
		task: task.prompt,
		cwd: task.cwd,
		status: "cancelled",
		modelOverride: task.modelOverride,
		thinkingOverride: task.thinkingOverride,
		launchModel: task.launchModel,
		launchThinking: task.launchThinking,
		cancellationNote: task.cancellationNote,
		output: "",
		references: [],
		exitCode: null,
		stderr: "",
		activities: [
			{
				kind: "status",
				text: activityText,
				timestamp: Date.now(),
			},
		],
		startedAt: null,
		finishedAt: null,
		steeringNotes: [],
	};
}

function formatSubagentDuration(result: SubagentTaskResult): string {
	if (result.startedAt === null || result.finishedAt === null) {
		return "not started";
	}
	const durationMs = Math.max(0, result.finishedAt - result.startedAt);
	if (durationMs < 1000) {
		return `${durationMs}ms`;
	}
	return `${(durationMs / 1000).toFixed(1)}s`;
}

function buildTaskSettingsParts(task: Pick<SubagentTaskProgress, "modelOverride" | "thinkingOverride">): string[] {
	const parts: string[] = [];
	if (task.modelOverride) {
		parts.push(`model ${task.modelOverride}`);
	}
	if (task.thinkingOverride) {
		parts.push(`thinking ${task.thinkingOverride}`);
	}
	return parts;
}

function formatTaskSettingsSuffix(task: Pick<SubagentTaskProgress, "modelOverride" | "thinkingOverride">): string {
	const parts = buildTaskSettingsParts(task);
	return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

function buildResultSummary(details: Pick<SubagentRunDetails, "successCount" | "failedCount" | "cancelledCount" | "launchedCount" | "totalCount">): string {
	return `${details.successCount} succeeded, ${details.failedCount} failed, ${details.cancelledCount} cancelled (${details.launchedCount}/${details.totalCount} launched)`;
}

function formatSubagentResult(result: SubagentTaskResult, index: number): string {
	const header = `Task ${index + 1} (${result.taskId}): ${result.status}`;
	const settingsLines = [
		result.modelOverride ? `Model override: ${result.modelOverride}` : undefined,
		result.thinkingOverride ? `Thinking override: ${result.thinkingOverride}` : undefined,
	].filter((line): line is string => !!line);

	if (result.status === "cancelled") {
		const lines = [header, `Prompt: ${result.task}`, `CWD: ${result.cwd}`, ...settingsLines];
		if (result.cancellationNote?.trim()) {
			lines.push(`Cancellation note: ${result.cancellationNote.trim()}`);
		}
		return lines.join("\n");
	}

	const recentActivities = result.activities.slice(-6);
	const activityText =
		recentActivities.length > 0
			? recentActivities.map((activity) => `- ${formatSubagentActivity(activity)}`).join("\n")
			: "- (no activity captured)";

	if (result.status === "failed") {
		const stderr = result.stderr.trim().length > 0 ? result.stderr.trim() : "unknown error";
		return [
			header,
			`Prompt: ${result.task}`,
			`CWD: ${result.cwd}`,
			...settingsLines,
			`Duration: ${formatSubagentDuration(result)}`,
			"Recent activity:",
			activityText,
			`Error: ${stderr}`,
		].join("\n");
	}

	const output = result.output.trim().length > 0 ? result.output.trim() : "(no output)";
	const refs = result.references.length > 0 ? result.references.map((ref) => `- ${ref}`).join("\n") : "- None";
	return [
		header,
		`Prompt: ${result.task}`,
		`CWD: ${result.cwd}`,
		...settingsLines,
		`Duration: ${formatSubagentDuration(result)}`,
		"Recent activity:",
		activityText,
		"",
		output,
		"",
		"References:",
		refs,
	].join("\n");
}

export function buildSubagentRunDetails(runId: string, results: SubagentTaskResult[]): SubagentRunDetails {
	const successCount = results.filter((result) => result.status === "completed").length;
	const failedCount = results.filter((result) => result.status === "failed").length;
	const cancelledCount = results.filter((result) => result.status === "cancelled").length;
	return {
		runId,
		tasks: results,
		launchedCount: results.length - cancelledCount,
		successCount,
		failedCount,
		cancelledCount,
		totalCount: results.length,
	};
}

function isSubagentProgressDetails(details: unknown): details is SubagentProgressDetails {
	if (!details || typeof details !== "object") {
		return false;
	}
	const value = details as Partial<SubagentProgressDetails>;
	return (
		typeof value.runId === "string" &&
		typeof value.completed === "number" &&
		typeof value.total === "number" &&
		typeof value.launchedCount === "number" &&
		typeof value.succeededCount === "number" &&
		typeof value.failedCount === "number" &&
		typeof value.cancelledCount === "number" &&
		Array.isArray(value.tasks)
	);
}

function isSubagentRunDetails(details: unknown): details is SubagentRunDetails {
	if (!details || typeof details !== "object") {
		return false;
	}
	const value = details as Partial<SubagentRunDetails>;
	return (
		typeof value.runId === "string" &&
		typeof value.successCount === "number" &&
		typeof value.failedCount === "number" &&
		typeof value.cancelledCount === "number" &&
		typeof value.launchedCount === "number" &&
		typeof value.totalCount === "number" &&
		Array.isArray(value.tasks)
	);
}

function statusIcon(status: SubagentTaskProgress["status"]): string {
	switch (status) {
		case "completed":
			return "✓";
		case "failed":
			return "✗";
		case "running":
			return "⏳";
		case "cancelled":
			return "⊘";
		default:
			return "○";
	}
}

function resultStatusIcon(result: SubagentTaskResult): string {
	switch (result.status) {
		case "completed":
			return "✓";
		case "failed":
			return "✗";
		case "cancelled":
			return "⊘";
	}
}

function resultStatusColor(status: SubagentTaskResult["status"]): "success" | "error" | "warning" {
	switch (status) {
		case "completed":
			return "success";
		case "failed":
			return "error";
		case "cancelled":
			return "warning";
	}
}

function progressStatusColor(status: SubagentTaskProgress["status"]): "success" | "error" | "warning" | "muted" {
	switch (status) {
		case "completed":
			return "success";
		case "failed":
			return "error";
		case "running":
			return "warning";
		case "cancelled":
			return "warning";
		default:
			return "muted";
	}
}

function buildInitialProgressTask(task: ReviewedSubagentTask): SubagentTaskProgress {
	return {
		taskId: task.taskId,
		prompt: task.prompt,
		cwd: task.cwd,
		status: task.launchStatus === "cancelled" ? "cancelled" : "queued",
		modelOverride: task.modelOverride,
		thinkingOverride: task.thinkingOverride,
		cancellationNote: task.cancellationNote,
		latestActivity:
			task.launchStatus === "cancelled"
				? task.cancellationNote?.trim()
					? `cancelled — ${summarizeSnippet(task.cancellationNote, 100)}`
					: "cancelled before launch"
				: undefined,
		activityCount: 0,
	};
}

function buildProgressTaskFromResult(task: SubagentTaskResult): SubagentTaskProgress {
	return {
		taskId: task.taskId,
		prompt: task.task,
		cwd: task.cwd,
		status: task.status,
		modelOverride: task.modelOverride,
		thinkingOverride: task.thinkingOverride,
		cancellationNote: task.cancellationNote,
		latestActivity:
			task.status === "cancelled"
				? task.cancellationNote?.trim()
					? `cancelled — ${summarizeSnippet(task.cancellationNote, 100)}`
					: "cancelled before launch"
				: task.activities.length > 0
					? formatSubagentActivity(task.activities[task.activities.length - 1]!)
					: undefined,
		activityCount: task.activities.length,
	};
}

export function registerSubagentTools(
	pi: ExtensionAPI,
	dependencies: {
		subagentsSchema: unknown;
		steerSubagentSchema: unknown;
	},
) {
	if (isSubagentExtensionDisabled()) {
		return;
	}

	const subagentRuns = new Map<string, SubagentRunRecord>();

	const rememberSubagentRun = (run: SubagentRunRecord) => {
		subagentRuns.set(run.runId, run);
		while (subagentRuns.size > 20) {
			const oldestRunId = subagentRuns.keys().next().value;
			if (!oldestRunId) {
				break;
			}
			subagentRuns.delete(oldestRunId);
		}
	};

	pi.registerTool({
		name: "subagents",
		label: "subagents",
		description:
			"Run one or more isolated research subagents in parallel with activity traces, interactive pre-launch review in UI mode, and run IDs for follow-up steering.",
		parameters: dependencies.subagentsSchema,
		renderCall(args, theme) {
			const tasks = (args.tasks as SubagentTask[] | undefined) ?? [];
			const lines: string[] = [
				`${theme.fg("toolTitle", theme.bold("subagents "))}${theme.fg("accent", `${tasks.length} task${tasks.length === 1 ? "" : "s"}`)}`,
			];
			for (const task of tasks.slice(0, SUBAGENT_PREVIEW_LIMIT)) {
				const taskId = task.id?.trim() || "(auto-id)";
				lines.push(`${theme.fg("muted", `- ${taskId}:`)} ${summarizeSnippet(task.prompt, 90)}`);
			}
			if (tasks.length > SUBAGENT_PREVIEW_LIMIT) {
				lines.push(theme.fg("muted", `... +${tasks.length - SUBAGENT_PREVIEW_LIMIT} more (Ctrl+O to expand after start)`));
			}
			return createText(lines.join("\n"));
		},
		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details;
			if (isPartial && isSubagentProgressDetails(details)) {
				const lines: string[] = [
					`${theme.fg("toolTitle", theme.bold("subagents "))}${theme.fg("accent", details.runId)} ${theme.fg("muted", `${details.completed}/${details.total} resolved · ${details.cancelledCount} cancelled`)}`,
				];
				const visibleTasks = expanded ? details.tasks : details.tasks.slice(0, SUBAGENT_PREVIEW_LIMIT);
				for (const task of visibleTasks) {
					const icon = theme.fg(progressStatusColor(task.status), statusIcon(task.status));
					const latest = formatProgressContext(task);
					const suffix = latest ? ` ${theme.fg("dim", summarizeSnippet(latest, 80))}` : "";
					const settings = formatTaskSettingsSuffix(task);
					lines.push(`${icon} ${theme.fg("accent", task.taskId)} ${theme.fg("muted", task.status)}${theme.fg("dim", settings)}${suffix}`);
				}
				if (!expanded && details.tasks.length > SUBAGENT_PREVIEW_LIMIT) {
					lines.push(theme.fg("muted", `... +${details.tasks.length - SUBAGENT_PREVIEW_LIMIT} more tasks`));
					lines.push(theme.fg("muted", "Press Ctrl+O to expand and show every task."));
				}
				return createText(lines.join("\n"));
			}

			if (!isSubagentRunDetails(details)) {
				const text = result.content.find((item) => item.type === "text");
				return createText(text?.type === "text" ? text.text : "(no output)");
			}

			const lines: string[] = [
				`${theme.fg("toolTitle", theme.bold("subagents "))}${theme.fg("accent", details.runId)} ${theme.fg("muted", buildResultSummary(details))}`,
			];
			const visibleTasks = expanded ? details.tasks : details.tasks.slice(0, SUBAGENT_PREVIEW_LIMIT);
			for (const task of visibleTasks) {
				const statusIconText = theme.fg(resultStatusColor(task.status), resultStatusIcon(task));
				if (!expanded) {
					const cancellationNote =
						task.status === "cancelled" && task.cancellationNote?.trim()
							? ` ${theme.fg("dim", `— ${summarizeSnippet(task.cancellationNote, 60)}`)}`
							: "";
					lines.push(
						`${statusIconText} ${theme.fg("accent", task.taskId)} ${theme.fg("muted", task.status)} ${theme.fg("muted", summarizeSnippet(task.task, 80))}${theme.fg("dim", formatTaskSettingsSuffix(task))}${cancellationNote}`,
					);
					continue;
				}

				const taskStatus = theme.fg(resultStatusColor(task.status), task.status);
				lines.push(`${statusIconText} ${theme.fg("accent", task.taskId)} ${taskStatus}`);
				lines.push(...indentMultiline(`Prompt: ${task.task}`, "  "));
				lines.push(`  ${theme.fg("muted", "CWD:")} ${task.cwd}`);
				if (task.modelOverride) {
					lines.push(`  ${theme.fg("muted", "Model override:")} ${task.modelOverride}`);
				}
				if (task.thinkingOverride) {
					lines.push(`  ${theme.fg("muted", "Thinking override:")} ${task.thinkingOverride}`);
				}
				if (task.status === "cancelled") {
					if (task.cancellationNote?.trim()) {
						lines.push(`  ${theme.fg("muted", "Cancellation note:")} ${task.cancellationNote.trim()}`);
					}
					continue;
				}

				lines.push(`  ${theme.fg("muted", "Duration:")} ${formatSubagentDuration(task)}`);
				if (task.steeringNotes.length > 0) {
					lines.push(`  ${theme.fg("muted", "Steering notes:")}`);
					for (const note of task.steeringNotes) {
						lines.push(...indentMultiline(`- ${note}`, "    "));
					}
				}

				lines.push(`  ${theme.fg("muted", "Activity:")}`);
				if (task.activities.length === 0) {
					lines.push(`    ${theme.fg("dim", "(no activity captured)")}`);
				} else {
					for (const activity of task.activities) {
						lines.push(`    ${theme.fg("dim", formatSubagentActivity(activity))}`);
					}
				}

				if (task.status === "failed") {
					const stderr = task.stderr.trim().length > 0 ? task.stderr.trim() : "unknown error";
					lines.push(`  ${theme.fg("error", "Error:")}`);
					lines.push(...indentMultiline(stderr, "    "));
					continue;
				}

				const output = task.output.trim().length > 0 ? task.output.trim() : "(no output)";
				lines.push(`  ${theme.fg("muted", "Output:")}`);
				lines.push(...indentMultiline(output, "    "));
				lines.push(`  ${theme.fg("muted", "References:")}`);
				if (task.references.length === 0) {
					lines.push("    - None");
				} else {
					for (const reference of task.references) {
						lines.push(`    - ${reference}`);
					}
				}
			}

			if (!expanded) {
				if (details.tasks.length > SUBAGENT_PREVIEW_LIMIT) {
					lines.push(theme.fg("muted", `... +${details.tasks.length - SUBAGENT_PREVIEW_LIMIT} more tasks`));
				}
				lines.push(theme.fg("muted", "Press Ctrl+O to expand and show all tasks, outputs, and activity traces."));
			} else {
				lines.push(theme.fg("muted", "Ctrl+O to collapse."));
			}
			return createText(lines.join("\n"));
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<SubagentRunDetails>> {
			const tasks = normalizeSubagentTasks(params.tasks as SubagentTask[]);
			const concurrency = resolveSubagentConcurrency(params.concurrency);
			if (concurrency === null) {
				return {
					isError: true,
					content: [{ type: "text", text: "concurrency must be an integer between 1 and 4." }],
				};
			}

			let reviewedTasks = createInitialReviewedSubagentTasks(tasks, ctx.cwd);
			if (ctx.hasUI) {
				const reviewResult = await runSubagentLaunchReview(ctx, tasks, {
					currentModelId: buildCurrentSubagentModelId(ctx.model),
					currentThinkingLevel: pi.getThinkingLevel(),
				});
				if (reviewResult === null) {
					return {
						isError: true,
						content: [{ type: "text", text: "Subagent launch cancelled before starting. No child processes were started." }],
					};
				}
				reviewedTasks = reviewResult;
			}

			const preparedTasks = prepareSubagentTasks(
				reviewedTasks,
				{
					model: buildCurrentSubagentModelId(ctx.model),
					thinking: pi.getThinkingLevel(),
				},
				ctx.modelRegistry,
			);
			const runId = createSubagentRunId();
			const progress: SubagentTaskProgress[] = reviewedTasks.map((task) => buildInitialProgressTask(task));

			const emitProgress = () => {
				const details = buildSubagentProgressDetails(runId, progress);
				onUpdate?.({
					content: [{ type: "text", text: buildSubagentProgressText(details) }],
					details,
				});
			};

			emitProgress();

			const results: Array<SubagentTaskResult | undefined> = preparedTasks.map((task) =>
				task.launchStatus === "cancelled" ? createCancelledSubagentTaskResult(task) : undefined,
			);
			const launchQueue = preparedTasks
				.map((task, index) => ({ task, index }))
				.filter((entry) => entry.task.launchStatus === "ready");

			await runWithConcurrencyLimit(launchQueue, concurrency, async ({ task, index }) => {
				progress[index] = {
					...progress[index],
					status: "running",
					latestActivity: "started",
				};
				emitProgress();

				const result = await runSubagentTask(task, {
					signal,
					onActivity: (activity) => {
						progress[index] = {
							...progress[index],
							latestActivity: formatSubagentActivity(activity),
							activityCount: progress[index]!.activityCount + 1,
						};
						emitProgress();
					},
				});

				results[index] = result;
				progress[index] = {
					...progress[index],
					status: result.status,
					latestActivity: result.status === "completed" ? "finished (ok)" : "finished (failed)",
				};
				emitProgress();
				return result;
			});

			const finalizedResults = results.map((result, index) => result ?? createCancelledSubagentTaskResult(preparedTasks[index]!));
			const details = buildSubagentRunDetails(runId, finalizedResults);
			rememberSubagentRun({
				runId,
				createdAt: Date.now(),
				tasks: finalizedResults,
			});

			const formatted = finalizedResults.map((result, index) => formatSubagentResult(result, index)).join("\n\n---\n\n");
			const summaryHeader = `Subagent research run ${runId}: ${buildResultSummary(details)}.`;
			const steeringHint =
				`Use steer_subagent with runId "${runId}" and a taskId to rerun or refine a specific task from this run.`;

			return {
				content: [{ type: "text", text: `${summaryHeader}\n${steeringHint}\n\n${formatted}` }],
				details,
				isError: details.failedCount > 0,
			};
		},
	});

	pi.registerTool({
		name: "steer_subagent",
		label: "steer subagent",
		description:
			"Rerun one task from a previous subagents run using runId/taskId and an extra steering instruction.",
		parameters: dependencies.steerSubagentSchema,
		renderCall(args, theme) {
			const instruction = summarizeSnippet(args.instruction ?? "", 90);
			const text = `${theme.fg("toolTitle", theme.bold("steer subagent "))}${theme.fg("accent", `${args.runId}/${args.taskId}`)}\n${theme.fg("muted", instruction)}`;
			return createText(text);
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<SubagentRunDetails>> {
			const runId = String(params.runId ?? "").trim();
			const taskId = String(params.taskId ?? "").trim();
			const instruction = String(params.instruction ?? "").trim();
			if (!runId || !taskId || !instruction) {
				return {
					isError: true,
					content: [{ type: "text", text: "runId, taskId, and instruction are required." }],
				};
			}

			const run = subagentRuns.get(runId);
			if (!run) {
				const knownRunIds = Array.from(subagentRuns.keys());
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: knownRunIds.length > 0
								? `Unknown runId "${runId}". Known runIds: ${knownRunIds.join(", ")}`
								: `Unknown runId "${runId}". No prior subagent runs are available.`,
						},
					],
				};
			}

			const taskIndex = run.tasks.findIndex((task) => task.taskId === taskId);
			if (taskIndex === -1) {
				const knownTaskIds = run.tasks.map((task) => task.taskId).join(", ");
				return {
					isError: true,
					content: [{ type: "text", text: `Unknown taskId "${taskId}" for run ${runId}. Known taskIds: ${knownTaskIds}` }],
				};
			}

			const previousTask = run.tasks[taskIndex]!;
			const steeringProgress = run.tasks.map((task, index) => ({
				...(index === taskIndex ? { ...buildProgressTaskFromResult(task), status: "running", latestActivity: "re-running with steering" } : buildProgressTaskFromResult(task)),
			}));
			const steeringProgressDetails = buildSubagentProgressDetails(runId, steeringProgress);
			onUpdate?.({
				content: [{ type: "text", text: buildSubagentProgressText(steeringProgressDetails) }],
				details: steeringProgressDetails,
			});

			const steeringNotes = [...previousTask.steeringNotes, instruction];
			const rerunTask = prepareSubagentTasks(
				[
					{
						taskId: previousTask.taskId,
						prompt: previousTask.task,
						cwd: previousTask.cwd,
						modelOverride: previousTask.modelOverride,
						thinkingOverride: previousTask.thinkingOverride,
						launchStatus: "ready",
					},
				],
				{
					model: previousTask.launchModel ?? buildCurrentSubagentModelId(ctx.model),
					thinking: previousTask.launchThinking ?? pi.getThinkingLevel(),
				},
				ctx.modelRegistry,
			)[0]!;

			const rerunResult = await runSubagentTask(rerunTask, {
				signal,
				steeringInstruction: instruction,
				previousOutput: previousTask.output,
				steeringNotes,
				onActivity: (activity) => {
					onUpdate?.({
						content: [
							{ type: "text", text: `Steering ${taskId}: ${formatSubagentActivity(activity)}` },
						],
					});
				},
			});

			run.tasks[taskIndex] = rerunResult;
			rememberSubagentRun(run);
			const details = buildSubagentRunDetails(runId, run.tasks);
			const summaryHeader = `Steered ${taskId} in run ${runId}. Run status: ${buildResultSummary(details)}.`;

			return {
				content: [
					{
						type: "text",
						text: `${summaryHeader}\n\n${formatSubagentResult(rerunResult, taskIndex)}`,
					},
				],
				details,
				isError: rerunResult.status === "failed",
			};
		},
	});
}
