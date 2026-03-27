import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { Dirent } from "node:fs";
import { copyFile, mkdtemp, readdir, rm, stat, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { AgentMessage, AgentToolResult } from "@mariozechner/pi-agent-core";
import { supportsXhigh, type TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI, SessionEntry } from "@mariozechner/pi-coding-agent";
import { createInitialReviewedSubagentTasks, runSubagentLaunchReview } from "./launch-tui";
import { createSubagentInspectorResultComponent, SubagentSteeringEditorComponent } from "./runtime-tui";
import {
	buildSessionEditorComponentKey,
	getRememberedSessionEditorComponentFactory,
	setRememberedSessionEditorComponent,
} from "@siddr/pi-shared-qna/session-editor-component";
import type {
	NormalizedSubagentTask,
	ReviewedSubagentTask,
	SubagentActivity,
	SubagentActivityKind,
	SubagentContextMode,
	SubagentDashboardRunState,
	SubagentDashboardTaskState,
	SubagentProgressDetails,
	SubagentRunDetails,
	SubagentRunRecord,
	SubagentTask,
	SubagentTaskProgress,
	SubagentTaskResult,
	SubagentThinkingLevel,
	SubagentTranscriptEntry,
} from "./types";
import {
	resolveSubagentConcurrency,
	resolveSubagentContextMode,
	resolveSubagentThinkingLevel,
	resolveSubagentToolThinkingLevel,
} from "./utils";

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
const USER_INPUT_WAIT_EVENT = "pi:waiting-for-user-input";
// Each subagent gets its own agent dir copy for auth/settings/models so concurrent
// child `pi` startup does not contend on global lock files.
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

function truncateSubagentTranscriptText(text: string): string {
	if (text.length <= MAX_SUBAGENT_TRANSCRIPT_STRING_LENGTH) {
		return text;
	}
	const omitted = text.length - MAX_SUBAGENT_TRANSCRIPT_STRING_LENGTH;
	return `${text.slice(0, MAX_SUBAGENT_TRANSCRIPT_STRING_LENGTH)}\n… [truncated ${omitted} chars]`;
}

function sanitizeSubagentTranscriptValue(value: unknown, depth: number = 0): unknown {
	if (typeof value === "string") {
		return truncateSubagentTranscriptText(value);
	}
	if (value === null || typeof value !== "object") {
		return value;
	}
	if (depth >= MAX_SUBAGENT_TRANSCRIPT_DEPTH) {
		return "[truncated]";
	}
	if (Array.isArray(value)) {
		const items = value.slice(0, MAX_SUBAGENT_TRANSCRIPT_ARRAY_ITEMS).map((item) => sanitizeSubagentTranscriptValue(item, depth + 1));
		if (value.length > MAX_SUBAGENT_TRANSCRIPT_ARRAY_ITEMS) {
			items.push(`[+${value.length - MAX_SUBAGENT_TRANSCRIPT_ARRAY_ITEMS} more items]`);
		}
		return items;
	}

	const entries = Object.entries(value);
	const sanitized: Record<string, unknown> = {};
	for (const [key, nestedValue] of entries.slice(0, MAX_SUBAGENT_TRANSCRIPT_OBJECT_KEYS)) {
		if (key === "data" && typeof nestedValue === "string") {
			sanitized[key] = `[omitted ${nestedValue.length} chars of binary data]`;
			continue;
		}
		sanitized[key] = sanitizeSubagentTranscriptValue(nestedValue, depth + 1);
	}
	if (entries.length > MAX_SUBAGENT_TRANSCRIPT_OBJECT_KEYS) {
		sanitized.__truncatedKeys = entries.length - MAX_SUBAGENT_TRANSCRIPT_OBJECT_KEYS;
	}
	return sanitized;
}

function cloneSubagentTranscriptEntry(entry: SubagentTranscriptEntry): SubagentTranscriptEntry {
	if (entry.kind === "assistantMessage" || entry.kind === "toolResultMessage") {
		return {
			...entry,
			message: sanitizeSubagentTranscriptValue(entry.message) as typeof entry.message,
		};
	}
	return {
		...entry,
		text: truncateSubagentTranscriptText(entry.text),
	};
}

function appendSubagentTranscriptEntry(transcript: SubagentTranscriptEntry[], entry: SubagentTranscriptEntry): SubagentTranscriptEntry {
	const sanitizedEntry = cloneSubagentTranscriptEntry(entry);
	transcript.push(sanitizedEntry);
	if (transcript.length > MAX_SUBAGENT_TRANSCRIPT_ENTRIES) {
		transcript.splice(0, transcript.length - MAX_SUBAGENT_TRANSCRIPT_ENTRIES);
	}
	return sanitizedEntry;
}

function buildTranscriptFromActivities(activities: SubagentActivity[]): SubagentTranscriptEntry[] {
	return activities.map((activity) => {
		if (activity.kind === "stderr") {
			return {
				kind: "stderr",
				text: activity.text,
				timestamp: activity.timestamp,
			} satisfies SubagentTranscriptEntry;
		}
		return {
			kind: "status",
			text: formatSubagentActivity(activity),
			timestamp: activity.timestamp,
		} satisfies SubagentTranscriptEntry;
	});
}

function normalizeSubagentTranscriptEntries(entries: SubagentTranscriptEntry[] | undefined, activities: SubagentActivity[]): SubagentTranscriptEntry[] {
	const sourceEntries = !Array.isArray(entries) || entries.length === 0 ? buildTranscriptFromActivities(activities) : entries;
	return sourceEntries.slice(-MAX_SUBAGENT_TRANSCRIPT_ENTRIES).map((entry) => cloneSubagentTranscriptEntry(entry));
}

function normalizeSubagentTaskResult(task: SubagentTaskResult): SubagentTaskResult {
	return {
		...task,
		activities: task.activities.map((activity) => ({ ...activity })),
		transcript: normalizeSubagentTranscriptEntries(task.transcript, task.activities),
		references: [...task.references],
		steeringNotes: [...task.steeringNotes],
	};
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
	launchContext: SubagentContextMode;
	forkSessionFile?: string;
};

type RunnableSubagentTask = PreparedSubagentTask;

type SubagentRunScope = {
	sessionKey: string;
};

const SUBAGENT_THINKING_LEVEL_ORDER: SubagentThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const MAX_SUBAGENT_TRANSCRIPT_ENTRIES = 120;
const MAX_SUBAGENT_TRANSCRIPT_STRING_LENGTH = 4000;
const MAX_SUBAGENT_TRANSCRIPT_ARRAY_ITEMS = 20;
const MAX_SUBAGENT_TRANSCRIPT_OBJECT_KEYS = 40;
const MAX_SUBAGENT_TRANSCRIPT_DEPTH = 5;

function buildSubagentSessionKey(ctx: { cwd: string; sessionManager?: { getSessionFile?: () => string | undefined; getSessionId?: () => string | undefined } }): string {
	return buildSessionEditorComponentKey(ctx);
}

function createQueuedDashboardTaskState(task: PreparedSubagentTask): SubagentDashboardTaskState {
	return {
		taskId: task.taskId,
		prompt: task.prompt,
		cwd: task.cwd,
		status: task.launchStatus === "cancelled" ? "cancelled" : "queued",
		modelOverride: task.modelOverride,
		thinkingOverride: task.thinkingOverride,
		launchModel: task.launchModel,
		launchThinking: task.launchThinking,
		launchContext: task.launchContext,
		forkSessionFile: task.forkSessionFile,
		cancellationNote: task.cancellationNote,
		latestActivity:
			task.launchStatus === "cancelled"
				? task.cancellationNote?.trim()
					? `cancelled — ${summarizeSnippet(task.cancellationNote, 100)}`
					: "cancelled before launch"
				: undefined,
		activityCount: task.launchStatus === "cancelled" ? 1 : 0,
		transcript:
			task.launchStatus === "cancelled"
				? [
						{
							kind: "status",
							text: task.cancellationNote?.trim() ? `cancelled before launch: ${task.cancellationNote.trim()}` : "cancelled before launch",
							timestamp: Date.now(),
						},
					]
				: [],
		output: "",
		references: [],
		stderr: "",
		startedAt: null,
		finishedAt: null,
		steeringNotes: [],
	};
}

function buildDashboardTaskStateFromResult(task: SubagentTaskResult): SubagentDashboardTaskState {
	const normalizedTask = normalizeSubagentTaskResult(task);
	return {
		taskId: normalizedTask.taskId,
		prompt: normalizedTask.task,
		cwd: normalizedTask.cwd,
		status: normalizedTask.status,
		modelOverride: normalizedTask.modelOverride,
		thinkingOverride: normalizedTask.thinkingOverride,
		launchModel: normalizedTask.launchModel,
		launchThinking: normalizedTask.launchThinking,
		launchContext: normalizedTask.launchContext,
		forkSessionFile: normalizedTask.forkSessionFile,
		cancellationNote: normalizedTask.cancellationNote,
		latestActivity:
			normalizedTask.status === "cancelled"
				? normalizedTask.cancellationNote?.trim()
					? `cancelled — ${summarizeSnippet(normalizedTask.cancellationNote, 100)}`
					: "cancelled before launch"
				: normalizedTask.activities.length > 0
					? formatSubagentActivity(normalizedTask.activities[normalizedTask.activities.length - 1]!)
					: undefined,
		activityCount: normalizedTask.activities.length,
		transcript: normalizedTask.transcript,
		output: normalizedTask.output,
		references: normalizedTask.references,
		stderr: normalizedTask.stderr,
		startedAt: normalizedTask.startedAt,
		finishedAt: normalizedTask.finishedAt,
		steeringNotes: normalizedTask.steeringNotes,
	};
}

function buildDashboardRunStateFromRecord(run: SubagentRunRecord): SubagentDashboardRunState {
	return {
		runId: run.runId,
		createdAt: run.createdAt,
		updatedAt: run.updatedAt,
		active: run.active,
		tasks: run.tasks.map((task) => buildDashboardTaskStateFromResult(task)),
	};
}

function buildProgressTaskFromDashboardTask(task: SubagentDashboardTaskState): SubagentTaskProgress {
	return {
		taskId: task.taskId,
		prompt: task.prompt,
		cwd: task.cwd,
		status: task.status,
		modelOverride: task.modelOverride,
		thinkingOverride: task.thinkingOverride,
		launchContext: task.launchContext,
		cancellationNote: task.cancellationNote,
		latestActivity: task.latestActivity,
		activityCount: task.activityCount,
	};
}

function buildCurrentSubagentModelId(model: { provider: string; id: string } | undefined): string | undefined {
	if (!model) {
		return undefined;
	}
	return `${model.provider}/${model.id}`;
}

function buildCurrentSubagentSessionFile(ctx: { sessionManager?: { getSessionFile?: () => string | undefined } }): string | undefined {
	return ctx.sessionManager?.getSessionFile?.();
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
		forkSessionFile?: string;
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
				task.thinkingOverride ?? task.defaultThinking ?? defaults.thinking,
			),
			launchContext: task.launchContext,
			forkSessionFile: task.launchContext === "fork" ? defaults.forkSessionFile : undefined,
		};
	});
}

type RunSubagentTaskOptions = {
	signal?: AbortSignal;
	onActivity?: (activity: SubagentActivity) => void;
	onTranscriptEntry?: (entry: SubagentTranscriptEntry) => void;
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
	const args = ["--mode", "json"];
	if (task.launchContext === "fork") {
		if (!task.forkSessionFile) {
			const timestamp = Date.now();
			return {
				taskId: task.taskId,
				task: task.prompt,
				cwd: task.cwd,
				status: "failed",
				modelOverride: task.modelOverride,
				thinkingOverride: task.thinkingOverride,
				launchModel: task.launchModel,
				launchThinking: task.launchThinking,
				launchContext: task.launchContext,
				forkSessionFile: undefined,
				cancellationNote: undefined,
				output: "",
				references: [],
				exitCode: null,
				stderr: "context \"fork\" requires a saved current session.",
				activities: [
					{
						kind: "status",
						text: "failed before launch: missing fork source session",
						timestamp,
					},
				],
				transcript: [
					{
						kind: "status",
						text: "failed before launch: missing fork source session",
						timestamp,
					},
				],
				startedAt: null,
				finishedAt: timestamp,
				steeringNotes: options?.steeringNotes ?? [],
			};
		}
		args.push("--fork", task.forkSessionFile);
	} else {
		args.push("--no-session");
	}
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
	const transcript: SubagentTranscriptEntry[] = [];
	const maxActivities = 120;

	const recordTranscriptEntry = (entry: SubagentTranscriptEntry) => {
		const sanitizedEntry = appendSubagentTranscriptEntry(transcript, entry);
		options?.onTranscriptEntry?.(cloneSubagentTranscriptEntry(sanitizedEntry));
	};

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

	const recordStatus = (text: string) => {
		recordActivity("status", text);
		recordTranscriptEntry({
			kind: "status",
			text,
			timestamp: Date.now(),
		});
	};

	const recordStderrLine = (text: string) => {
		recordActivity("stderr", text);
		recordTranscriptEntry({
			kind: "stderr",
			text,
			timestamp: Date.now(),
		});
	};

	recordStatus("started");

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
			recordStatus("aborting");
			try {
				child.kill("SIGTERM");
			} catch {
				return;
			}

			forceKillTimer = setTimeout(() => {
				if (closed) {
					return;
				}
				recordStatus("forcing termination");
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

				recordTranscriptEntry({
					kind: "assistantMessage",
					timestamp: parsed.message.timestamp,
					message: parsed.message,
				});

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

			if (parsed.type === "tool_result_end" && parsed.message && parsed.message.role === "toolResult") {
				recordTranscriptEntry({
					kind: "toolResultMessage",
					timestamp: parsed.message.timestamp,
					message: parsed.message,
				});
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
					recordStderrLine(line);
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
			recordStatus(`finished with exit code ${exitCode}`);
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
				launchContext: task.launchContext,
				forkSessionFile: task.forkSessionFile,
				cancellationNote: undefined,
				output,
				references: extractReferences(output),
				exitCode,
				stderr: aborted ? "aborted" : stderr,
				activities,
				transcript,
				startedAt,
				finishedAt: Date.now(),
				steeringNotes: options?.steeringNotes ?? [],
			});
		});

		child.on("error", (error) => {
			cleanupAbortHandling();
			recordStderrLine(error.message);
			resolveOnce({
				taskId: task.taskId,
				task: task.prompt,
				cwd: task.cwd,
				status: "failed",
				modelOverride: task.modelOverride,
				thinkingOverride: task.thinkingOverride,
				launchModel: task.launchModel,
				launchThinking: task.launchThinking,
				launchContext: task.launchContext,
				forkSessionFile: task.forkSessionFile,
				cancellationNote: undefined,
				output: "",
				references: [],
				exitCode: 1,
				stderr: error.message,
				activities,
				transcript,
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
	const timestamp = Date.now();
	return {
		taskId: task.taskId,
		task: task.prompt,
		cwd: task.cwd,
		status: "cancelled",
		modelOverride: task.modelOverride,
		thinkingOverride: task.thinkingOverride,
		launchModel: task.launchModel,
		launchThinking: task.launchThinking,
		launchContext: task.launchContext,
		forkSessionFile: task.forkSessionFile,
		cancellationNote: task.cancellationNote,
		output: "",
		references: [],
		exitCode: null,
		stderr: "",
		activities: [
			{
				kind: "status",
				text: activityText,
				timestamp,
			},
		],
		transcript: [
			{
				kind: "status",
				text: activityText,
				timestamp,
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

function buildTaskSettingsParts(
	task: Pick<SubagentTaskProgress, "modelOverride" | "thinkingOverride" | "launchContext">,
): string[] {
	const parts: string[] = [];
	if (task.modelOverride) {
		parts.push(`model ${task.modelOverride}`);
	}
	if (task.thinkingOverride) {
		parts.push(`thinking ${task.thinkingOverride}`);
	}
	if (task.launchContext === "fork") {
		parts.push("context fork");
	}
	return parts;
}

function formatTaskSettingsSuffix(
	task: Pick<SubagentTaskProgress, "modelOverride" | "thinkingOverride" | "launchContext">,
): string {
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
		result.launchContext === "fork" ? "Context: fork" : undefined,
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
	const normalizedResults = results.map((result) => normalizeSubagentTaskResult(result));
	const successCount = normalizedResults.filter((result) => result.status === "completed").length;
	const failedCount = normalizedResults.filter((result) => result.status === "failed").length;
	const cancelledCount = normalizedResults.filter((result) => result.status === "cancelled").length;
	return {
		runId,
		tasks: normalizedResults,
		launchedCount: normalizedResults.length - cancelledCount,
		successCount,
		failedCount,
		cancelledCount,
		totalCount: normalizedResults.length,
	};
}

export function reconstructSubagentRunsFromEntries(
	entries: SessionEntry[],
	scope: { sessionKey: string } = { sessionKey: "reconstructed" },
): SubagentRunRecord[] {
	const runs = new Map<string, SubagentRunRecord>();
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "toolResult") {
			continue;
		}
		if (entry.message.toolName !== "subagents" && entry.message.toolName !== "steer_subagent") {
			continue;
		}
		if (!isSubagentRunDetails(entry.message.details)) {
			continue;
		}
		const details = entry.message.details;
		const existing = runs.get(details.runId);
		runs.set(details.runId, {
			runId: details.runId,
			createdAt: existing?.createdAt ?? entry.message.timestamp,
			updatedAt: entry.message.timestamp,
			active: false,
			tasks: details.tasks.map((task) => normalizeSubagentTaskResult(task as SubagentTaskResult)),
			sessionKey: scope.sessionKey,
		});
	}
	return Array.from(runs.values()).sort((left, right) => right.updatedAt - left.updatedAt);
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
		launchContext: task.launchContext,
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
		launchContext: task.launchContext,
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
	const liveSubagentRuns = new Map<string, SubagentDashboardRunState>();
	const runScopes = new Map<string, SubagentRunScope>();
	const runListeners = new Set<() => void>();

	const notifyRunListeners = () => {
		for (const listener of runListeners) {
			listener();
		}
	};

	const subscribeToRunUpdates = (listener: () => void) => {
		runListeners.add(listener);
		return () => {
			runListeners.delete(listener);
		};
	};

	const emitWaitingForUserInput = (id: string, waiting: boolean) => {
		pi.events.emit(USER_INPUT_WAIT_EVENT, {
			source: "task-subagents:launch-review",
			id,
			waiting,
		});
	};

	const rememberSubagentRun = (run: SubagentRunRecord) => {
		const normalizedRun: SubagentRunRecord = {
			...run,
			tasks: run.tasks.map((task) => normalizeSubagentTaskResult(task)),
			active: false,
			updatedAt: run.updatedAt,
		};
		subagentRuns.set(normalizedRun.runId, normalizedRun);
		runScopes.set(normalizedRun.runId, { sessionKey: normalizedRun.sessionKey });
		liveSubagentRuns.delete(normalizedRun.runId);
		while (subagentRuns.size > 20) {
			const oldestRunId = subagentRuns.keys().next().value;
			if (!oldestRunId) {
				break;
			}
			subagentRuns.delete(oldestRunId);
			runScopes.delete(oldestRunId);
		}
		if (activeInspector?.runId === normalizedRun.runId) {
			closeSubagentInspector();
			return;
		}
		notifyRunListeners();
	};

	const setLiveSubagentRun = (run: SubagentDashboardRunState, scope: SubagentRunScope) => {
		liveSubagentRuns.set(run.runId, {
			...run,
			tasks: run.tasks.map((task) => ({
				...task,
				references: [...task.references],
				steeringNotes: [...task.steeringNotes],
				transcript: task.transcript.map((entry) => cloneSubagentTranscriptEntry(entry)),
			})),
		});
		runScopes.set(run.runId, scope);
		notifyRunListeners();
	};

	const updateLiveSubagentRun = (
		runId: string,
		updater: (run: SubagentDashboardRunState) => void,
	) => {
		const run = liveSubagentRuns.get(runId);
		if (!run) {
			return;
		}
		updater(run);
		run.updatedAt = Date.now();
		notifyRunListeners();
	};

	const hydrateSubagentRunsFromBranch = (ctx: { cwd: string; sessionManager?: { getBranch?: () => SessionEntry[]; getSessionFile?: () => string | undefined; getSessionId?: () => string | undefined } }) => {
		const scope = { sessionKey: buildSubagentSessionKey(ctx) };
		const reconstructedRuns = reconstructSubagentRunsFromEntries(ctx.sessionManager?.getBranch?.() ?? [], scope);
		for (const run of reconstructedRuns) {
			subagentRuns.set(run.runId, run);
			runScopes.set(run.runId, scope);
		}
		return reconstructedRuns;
	};

	const getSubagentRunRecord = (runId: string, ctx: { cwd: string; sessionManager?: { getBranch?: () => SessionEntry[]; getSessionFile?: () => string | undefined; getSessionId?: () => string | undefined } }) => {
		const existing = subagentRuns.get(runId);
		if (existing) {
			return existing;
		}
		return hydrateSubagentRunsFromBranch(ctx).find((run) => run.runId === runId);
	};

	const getLatestDashboardRun = (ctx: { cwd: string; sessionManager?: { getBranch?: () => SessionEntry[]; getSessionFile?: () => string | undefined; getSessionId?: () => string | undefined } }) => {
		const scopeKey = buildSubagentSessionKey(ctx);
		return Array.from(liveSubagentRuns.values())
			.filter((run) => runScopes.get(run.runId)?.sessionKey === scopeKey)
			.sort((left, right) => right.updatedAt - left.updatedAt)[0];
	};

	const getDashboardRunById = (runId: string) => {
		const liveRun = liveSubagentRuns.get(runId);
		if (liveRun) {
			return liveRun;
		}
		const run = subagentRuns.get(runId);
		return run ? buildDashboardRunStateFromRecord(run) : undefined;
	};

	type ActiveSubagentInspector = {
		sessionKey: string;
		runId: string;
		selectedTaskId: string;
		savedEditorText: string;
		drafts: Map<string, string>;
		statusMessage?: string;
		restoreEditor: (text: string) => void;
	};

	let activeInspector: ActiveSubagentInspector | undefined;

	const getActiveInspectorRun = () => {
		if (!activeInspector) {
			return undefined;
		}
		return getDashboardRunById(activeInspector.runId);
	};

	const getInspectorSelectedTaskId = (runId: string) => {
		return activeInspector?.runId === runId ? activeInspector.selectedTaskId : undefined;
	};

	const closeSubagentInspector = () => {
		if (!activeInspector) {
			return;
		}
		const { restoreEditor, savedEditorText } = activeInspector;
		activeInspector = undefined;
		restoreEditor(savedEditorText);
		notifyRunListeners();
	};

	const openSubagentInspector = (
		ctx: {
			cwd: string;
			sessionManager?: { getSessionFile?: () => string | undefined; getSessionId?: () => string | undefined };
			ui: {
				getEditorText: () => string;
				setEditorComponent: (factory: any) => void;
				setEditorText: (text: string) => void;
				notify: (message: string, type?: "info" | "warning" | "error") => void;
			};
		},
		run: SubagentDashboardRunState,
	) => {
		const firstTaskId = run.tasks[0]?.taskId;
		if (!firstTaskId) {
			ctx.ui.notify("No subagent task is available for inspection.", "info");
			return;
		}
		const sessionKey = buildSubagentSessionKey(ctx);
		const savedEditorText = activeInspector?.sessionKey === sessionKey ? activeInspector.savedEditorText : ctx.ui.getEditorText();
		const previousEditorFactory = getRememberedSessionEditorComponentFactory(ctx);
		activeInspector = {
			sessionKey,
			runId: run.runId,
			selectedTaskId: firstTaskId,
			savedEditorText,
			drafts: activeInspector?.runId === run.runId ? activeInspector.drafts : new Map<string, string>(),
			statusMessage: undefined,
			restoreEditor: (text) => {
				setRememberedSessionEditorComponent(ctx, previousEditorFactory);
				ctx.ui.setEditorText(text);
			},
		};
		ctx.ui.setEditorComponent((tui: { requestRender: () => void }, theme: any) =>
			new SubagentSteeringEditorComponent(
				tui,
				{
					accentColor: (text) => {
						const accented = theme.fg?.("accent", text) ?? text;
						return theme.selectList?.matchHighlight?.(accented) ?? accented;
					},
					mutedColor: (text) => theme.selectList?.itemSecondary?.(text) ?? text,
					dimColor: theme.borderColor,
				},
				{
					getRunState: getActiveInspectorRun,
					getSelectedTaskId: () => activeInspector?.selectedTaskId,
					setSelectedTaskId: (taskId) => {
						if (!activeInspector) {
							return;
						}
						activeInspector.selectedTaskId = taskId;
						notifyRunListeners();
					},
					getDraft: (taskId) => activeInspector?.drafts.get(taskId) ?? "",
					setDraft: (taskId, draft) => {
						if (!activeInspector) {
							return;
						}
						activeInspector.drafts.set(taskId, draft);
					},
					submitDraft: async (taskId, draft) => {
						if (!activeInspector) {
							return;
						}
						const instruction = draft.trim();
						if (!instruction) {
							activeInspector.statusMessage = "Enter a steering instruction first.";
							notifyRunListeners();
							return;
						}
						const runRecord = getSubagentRunRecord(activeInspector.runId, ctx);
						if (!runRecord) {
							activeInspector.statusMessage = `Unknown runId \"${activeInspector.runId}\".`;
							notifyRunListeners();
							return;
						}
						activeInspector.statusMessage = `Steering ${taskId}...`;
						notifyRunListeners();
						try {
							await rerunSubagentTaskInRun(runRecord, taskId, instruction, { ctx });
							if (activeInspector) {
								activeInspector.drafts.set(taskId, "");
								activeInspector.statusMessage = `Steered ${taskId}.`;
							}
						} catch (error) {
							if (activeInspector) {
								activeInspector.statusMessage = error instanceof Error ? error.message : String(error);
							}
						}
						notifyRunListeners();
					},
					close: () => closeSubagentInspector(),
					subscribe: subscribeToRunUpdates,
					getStatusMessage: () => activeInspector?.statusMessage,
				},
			),
		);
		notifyRunListeners();
	};

	type PendingLaunchReviewRequest = {
		ctx: any;
		reviewedTasks: ReviewedSubagentTask[];
		currentModelId?: string;
		currentThinkingLevel?: SubagentThinkingLevel;
		hasForkSource: boolean;
		resolve: (tasks: ReviewedSubagentTask[] | null) => void;
		reject: (error: unknown) => void;
	};

	type PendingLaunchReviewBatch = {
		requests: PendingLaunchReviewRequest[];
		mergedTasks: ReviewedSubagentTask[];
		mergedTaskRefs: Array<{ requestIndex: number; taskIndex: number; originalTaskId: string }>;
		usedTaskIds: Set<string>;
		ctx: any;
		currentModelId?: string;
		currentThinkingLevel?: SubagentThinkingLevel;
		hasForkSource: boolean;
		status: "collecting" | "reviewing";
		timer?: ReturnType<typeof setTimeout>;
		appendTasks?: (tasks: ReviewedSubagentTask[]) => void;
	};

	let pendingLaunchReviewBatch: PendingLaunchReviewBatch | undefined;

	const createUniqueReviewTaskId = (taskId: string, used: Set<string>): string => {
		let candidate = taskId;
		let suffix = 2;
		while (used.has(candidate)) {
			candidate = `${taskId}-${suffix}`;
			suffix += 1;
		}
		used.add(candidate);
		return candidate;
	};

	const addRequestToLaunchReviewBatch = (batch: PendingLaunchReviewBatch, request: PendingLaunchReviewRequest) => {
		const requestIndex = batch.requests.length;
		batch.requests.push(request);
		batch.hasForkSource ||= request.hasForkSource;
		const appendedTasks: ReviewedSubagentTask[] = [];
		for (let taskIndex = 0; taskIndex < request.reviewedTasks.length; taskIndex++) {
			const task = request.reviewedTasks[taskIndex]!;
			const mergedTask = {
				...task,
				taskId: createUniqueReviewTaskId(task.taskId, batch.usedTaskIds),
			};
			batch.mergedTasks.push(mergedTask);
			batch.mergedTaskRefs.push({ requestIndex, taskIndex, originalTaskId: task.taskId });
			appendedTasks.push(mergedTask);
		}
		if (batch.status === "reviewing") {
			batch.appendTasks?.(appendedTasks);
		}
	};

	const flushPendingLaunchReviewBatch = async (batch: PendingLaunchReviewBatch) => {
		if (batch.status !== "collecting") {
			return;
		}
		batch.status = "reviewing";
		if (batch.timer) {
			clearTimeout(batch.timer);
			batch.timer = undefined;
		}

		try {
			const reviewedTasks = await runSubagentLaunchReview(batch.ctx, batch.mergedTasks, {
				currentModelId: batch.currentModelId,
				currentThinkingLevel: batch.currentThinkingLevel,
				hasForkSource: batch.hasForkSource,
				onReady: (handle) => {
					batch.appendTasks = handle.appendTasks;
				},
			});
			if (reviewedTasks === null) {
				for (const request of batch.requests) {
					request.resolve(null);
				}
				return;
			}

			const reviewedTasksByRequest = batch.requests.map((request) => new Array<ReviewedSubagentTask>(request.reviewedTasks.length));
			for (let index = 0; index < reviewedTasks.length; index++) {
				const reviewedTask = reviewedTasks[index]!;
				const ref = batch.mergedTaskRefs[index]!;
				reviewedTasksByRequest[ref.requestIndex]![ref.taskIndex] = {
					...reviewedTask,
					taskId: ref.originalTaskId,
				};
			}

			for (let requestIndex = 0; requestIndex < batch.requests.length; requestIndex++) {
				batch.requests[requestIndex]!.resolve(reviewedTasksByRequest[requestIndex]!);
			}
		} catch (error) {
			for (const request of batch.requests) {
				request.reject(error);
			}
		} finally {
			if (pendingLaunchReviewBatch === batch) {
				pendingLaunchReviewBatch = undefined;
			}
		}
	};

	const enqueueMergedLaunchReview = (request: Omit<PendingLaunchReviewRequest, "resolve" | "reject">) => {
		return new Promise<ReviewedSubagentTask[] | null>((resolve, reject) => {
			const requestWithCallbacks = { ...request, resolve, reject };
			if (!pendingLaunchReviewBatch) {
				pendingLaunchReviewBatch = {
					requests: [],
					mergedTasks: [],
					mergedTaskRefs: [],
					usedTaskIds: new Set<string>(),
					ctx: request.ctx,
					currentModelId: request.currentModelId,
					currentThinkingLevel: request.currentThinkingLevel,
					hasForkSource: request.hasForkSource,
					status: "collecting",
				};
				pendingLaunchReviewBatch.timer = setTimeout(() => {
					const batch = pendingLaunchReviewBatch;
					if (!batch) {
						return;
					}
					void flushPendingLaunchReviewBatch(batch);
				}, 0);
			}
			const batch = pendingLaunchReviewBatch;
			if (!batch) {
				reject(new Error("expected pending launch review batch"));
				return;
			}
			addRequestToLaunchReviewBatch(batch, requestWithCallbacks);
		});
	};

	const emitDashboardProgressUpdate = (
		runId: string,
		tasks: SubagentDashboardTaskState[],
		onUpdate?: (update: { content: Array<{ type: "text"; text: string }>; details: SubagentProgressDetails }) => void,
	) => {
		if (!onUpdate) {
			return;
		}
		const progressDetails = buildSubagentProgressDetails(runId, tasks.map((task) => buildProgressTaskFromDashboardTask(task)));
		onUpdate({
			content: [{ type: "text", text: buildSubagentProgressText(progressDetails) }],
			details: progressDetails,
		});
	};

	const rerunSubagentTaskInRun = async (
		run: SubagentRunRecord,
		taskId: string,
		instruction: string,
		options: {
			signal?: AbortSignal;
			onUpdate?: (update: { content: Array<{ type: "text"; text: string }>; details?: SubagentProgressDetails }) => void;
			ctx: any;
		},
	) => {
		const taskIndex = run.tasks.findIndex((task) => task.taskId === taskId);
		if (taskIndex === -1) {
			throw new Error(`Unknown taskId "${taskId}" for run ${run.runId}.`);
		}

		const previousTask = normalizeSubagentTaskResult(run.tasks[taskIndex]!);
		const steeringNotes = [...previousTask.steeringNotes, instruction];
		const liveRun = buildDashboardRunStateFromRecord(run);
		liveRun.active = true;
		liveRun.updatedAt = Date.now();
		liveRun.tasks[taskIndex] = {
			...liveRun.tasks[taskIndex]!,
			status: "running",
			latestActivity: "re-running with steering",
			activityCount: 0,
			transcript: [
				{
					kind: "status",
					text: "re-running with steering",
					timestamp: liveRun.updatedAt,
				},
			],
			output: "",
			references: [],
			stderr: "",
			startedAt: liveRun.updatedAt,
			finishedAt: null,
			steeringNotes,
		};
		setLiveSubagentRun(liveRun, { sessionKey: run.sessionKey });
		emitDashboardProgressUpdate(run.runId, liveRun.tasks, options.onUpdate);

		const rerunTask = prepareSubagentTasks(
			[
				{
					taskId: previousTask.taskId,
					prompt: previousTask.task,
					cwd: previousTask.cwd,
					modelOverride: previousTask.modelOverride,
					thinkingOverride: previousTask.thinkingOverride,
					launchContext: previousTask.launchContext,
					launchStatus: "ready",
				},
			],
			{
				model: previousTask.launchModel ?? buildCurrentSubagentModelId(options.ctx.model),
				thinking: previousTask.launchThinking ?? resolveSubagentThinkingLevel(pi.getThinkingLevel()),
				forkSessionFile: previousTask.forkSessionFile,
			},
			options.ctx.modelRegistry,
		)[0]!;

		const rerunResult = await runSubagentTask(rerunTask, {
			signal: options.signal,
			steeringInstruction: instruction,
			previousOutput: previousTask.output,
			steeringNotes,
			onActivity: (activity) => {
				updateLiveSubagentRun(run.runId, (currentRun) => {
					const currentTask = currentRun.tasks[taskIndex];
					if (!currentTask) {
						return;
					}
					currentTask.latestActivity = formatSubagentActivity(activity);
					currentTask.activityCount += 1;
				});
				const currentRun = liveSubagentRuns.get(run.runId);
				if (currentRun) {
					emitDashboardProgressUpdate(run.runId, currentRun.tasks, options.onUpdate);
				}
			},
			onTranscriptEntry: (entry) => {
				updateLiveSubagentRun(run.runId, (currentRun) => {
					const currentTask = currentRun.tasks[taskIndex];
					if (!currentTask) {
						return;
					}
					appendSubagentTranscriptEntry(currentTask.transcript, entry);
				});
			},
		});

		run.tasks[taskIndex] = normalizeSubagentTaskResult(rerunResult);
		run.updatedAt = Date.now();
		run.active = false;
		rememberSubagentRun(run);
		const details = buildSubagentRunDetails(run.runId, run.tasks);
		return {
			taskIndex,
			rerunResult,
			details,
		};
	};

	pi.registerShortcut("ctrl+shift+o", {
		description: "Inspect the latest active subagent run in the main tool result view",
		handler: async (ctx) => {
			const sessionKey = buildSubagentSessionKey(ctx);
			if (activeInspector?.sessionKey === sessionKey) {
				closeSubagentInspector();
				return;
			}
			const run = getLatestDashboardRun(ctx);
			if (!run) {
				ctx.ui.notify("No active subagent run is available right now.", "info");
				return;
			}
			openSubagentInspector(ctx, run);
		},
	});

	pi.registerTool({
		name: "subagents",
		label: "subagents",
		description:
			"Launch one or more isolated subagents with activity traces, interactive pre-launch review in UI mode, and run IDs for follow-up steering. Use this only when asked to use subagents.",
		parameters: dependencies.subagentsSchema,
		renderCall(args, theme) {
			const tasks = (args.tasks as SubagentTask[] | undefined) ?? [];
			const contextMode = resolveSubagentContextMode(args.context) ?? "fresh";
			const requestedThinking = resolveSubagentThinkingLevel(args.thinking_level);
			const lines: string[] = [
				`${theme.fg("toolTitle", theme.bold("subagents "))}${theme.fg("accent", `${tasks.length} task${tasks.length === 1 ? "" : "s"}`)}`,
			];
			const settings: string[] = [];
			if (contextMode === "fork") {
				settings.push("context fork");
			}
			if (requestedThinking) {
				settings.push(`thinking ${requestedThinking}`);
			}
			if (settings.length > 0) {
				lines.push(theme.fg("muted", settings.join(" · ")));
			}
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
			const inspectorRunId = activeInspector?.runId;
			if (
				inspectorRunId &&
				((isPartial && isSubagentProgressDetails(details) && details.runId === inspectorRunId) ||
					(isSubagentRunDetails(details) && details.runId === inspectorRunId))
			) {
				return createSubagentInspectorResultComponent({
					runId: inspectorRunId,
					getRunState: () => getDashboardRunById(inspectorRunId),
					getSelectedTaskId: () => getInspectorSelectedTaskId(inspectorRunId),
					accentColor: (text) => theme.fg("accent", text),
					mutedColor: (text) => theme.fg("muted", text),
				});
			}
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
					lines.push(theme.fg("muted", "Press Ctrl+O to expand or Ctrl+Shift+O to inspect this run in the main tool view."));
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
				if (task.launchContext === "fork") {
					lines.push(`  ${theme.fg("muted", "Context:")} fork`);
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
				lines.push(theme.fg("muted", "Press Ctrl+O to expand."));
			} else {
				lines.push(theme.fg("muted", "Ctrl+O to collapse."));
			}
			return createText(lines.join("\n"));
		},
		async execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<SubagentRunDetails>> {
			const tasks = normalizeSubagentTasks(params.tasks as SubagentTask[]);
			const concurrency = resolveSubagentConcurrency(params.concurrency);
			if (concurrency === null) {
				return {
					isError: true,
					content: [{ type: "text", text: "concurrency must be an integer between 1 and 4." }],
				};
			}

			const currentThinkingLevel = resolveSubagentThinkingLevel(pi.getThinkingLevel());
			const defaultThinkingLevel = resolveSubagentToolThinkingLevel(params.thinking_level, currentThinkingLevel);
			if (defaultThinkingLevel === null) {
				return {
					isError: true,
					content: [{ type: "text", text: 'thinking_level must be one of: off, minimal, low, medium, high, xhigh.' }],
				};
			}

			const requestedContext = resolveSubagentContextMode(params.context);
			if (requestedContext === null) {
				return {
					isError: true,
					content: [{ type: "text", text: 'context must be either "fresh" or "fork".' }],
				};
			}

			const currentSessionFile = buildCurrentSubagentSessionFile(ctx);
			if (requestedContext === "fork" && !currentSessionFile) {
				return {
					isError: true,
					content: [{ type: "text", text: 'context "fork" requires a saved current session.' }],
				};
			}
			let reviewedTasks = createInitialReviewedSubagentTasks(tasks, ctx.cwd, {
				defaultThinking: params.thinking_level === undefined ? undefined : defaultThinkingLevel ?? undefined,
				launchContext: requestedContext,
			});
			if (ctx.hasUI) {
				emitWaitingForUserInput(toolCallId, true);
				try {
					const reviewResult = await enqueueMergedLaunchReview({
						ctx,
						reviewedTasks,
						currentModelId: buildCurrentSubagentModelId(ctx.model),
						currentThinkingLevel,
						hasForkSource: !!currentSessionFile,
					});
					if (reviewResult === null) {
						return {
							isError: true,
							content: [{ type: "text", text: "Subagent launch cancelled before starting. No child processes were started." }],
						};
					}
					reviewedTasks = reviewResult;
				} finally {
					emitWaitingForUserInput(toolCallId, false);
				}
			}

			if (
				reviewedTasks.some((task) => task.launchStatus === "ready" && task.launchContext === "fork") &&
				!currentSessionFile
			) {
				return {
					isError: true,
					content: [{ type: "text", text: 'context "fork" requires a saved current session.' }],
				};
			}

			const preparedTasks = prepareSubagentTasks(
				reviewedTasks,
				{
					model: buildCurrentSubagentModelId(ctx.model),
					thinking: currentThinkingLevel,
					forkSessionFile: currentSessionFile,
				},
				ctx.modelRegistry,
			);
			const runId = createSubagentRunId();
			const createdAt = Date.now();
			const sessionScope = { sessionKey: buildSubagentSessionKey(ctx) };
			const progress: SubagentTaskProgress[] = reviewedTasks.map((task) => buildInitialProgressTask(task));

			const emitProgress = () => {
				const details = buildSubagentProgressDetails(runId, progress);
				onUpdate?.({
					content: [{ type: "text", text: buildSubagentProgressText(details) }],
					details,
				});
			};

			const liveRunState: SubagentDashboardRunState = {
				runId,
				createdAt,
				updatedAt: createdAt,
				active: true,
				tasks: preparedTasks.map((task) => createQueuedDashboardTaskState(task)),
			};
			setLiveSubagentRun(liveRunState, sessionScope);
			emitProgress();

			const results: Array<SubagentTaskResult | undefined> = preparedTasks.map((task) =>
				task.launchStatus === "cancelled" ? createCancelledSubagentTaskResult(task) : undefined,
			);
			const launchQueue = preparedTasks
				.map((task, index) => ({ task, index }))
				.filter((entry) => entry.task.launchStatus === "ready");

			await runWithConcurrencyLimit(launchQueue, concurrency, async ({ task, index }) => {
				updateLiveSubagentRun(runId, (currentRun) => {
					const currentTask = currentRun.tasks[index];
					if (!currentTask) {
						return;
					}
					currentTask.status = "running";
					currentTask.latestActivity = "started";
					currentTask.activityCount = 0;
					currentTask.transcript = [];
					currentTask.output = "";
					currentTask.references = [];
					currentTask.stderr = "";
					currentTask.startedAt = Date.now();
					currentTask.finishedAt = null;
				});
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
						updateLiveSubagentRun(runId, (currentRun) => {
							const currentTask = currentRun.tasks[index];
							if (!currentTask) {
								return;
							}
							currentTask.latestActivity = formatSubagentActivity(activity);
							currentTask.activityCount += 1;
						});
						emitProgress();
					},
					onTranscriptEntry: (entry) => {
						updateLiveSubagentRun(runId, (currentRun) => {
							const currentTask = currentRun.tasks[index];
							if (!currentTask) {
								return;
							}
							appendSubagentTranscriptEntry(currentTask.transcript, entry);
						});
					},
				});

				results[index] = result;
				updateLiveSubagentRun(runId, (currentRun) => {
					currentRun.tasks[index] = buildDashboardTaskStateFromResult(result);
				});
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
				createdAt,
				updatedAt: Date.now(),
				active: false,
				tasks: finalizedResults,
				sessionKey: sessionScope.sessionKey,
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

			const run = getSubagentRunRecord(runId, ctx);
			if (!run) {
				const knownRunIds = Array.from(new Set([...subagentRuns.keys(), ...hydrateSubagentRunsFromBranch(ctx).map((item) => item.runId)]));
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

			const { rerunResult, details } = await rerunSubagentTaskInRun(run, taskId, instruction, {
				signal,
				onUpdate,
				ctx,
			});
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
