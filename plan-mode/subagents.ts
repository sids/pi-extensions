import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { AgentMessage, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type {
	NormalizedSubagentTask,
	PlanModeState,
	SubagentActivity,
	SubagentActivityKind,
	SubagentProgressDetails,
	SubagentRunDetails,
	SubagentRunRecord,
	SubagentTask,
	SubagentTaskProgress,
	SubagentTaskResult,
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

const SUBAGENT_TASK_PREVIEW_LIMIT = 4;

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

function buildSubagentProgressText(
	runId: string,
	tasks: SubagentTaskProgress[],
	completed: number,
	total: number,
): string {
	const lines: string[] = [`Subagent run ${runId}: ${completed}/${total} complete`];
	for (const task of tasks) {
		const status = task.status.padEnd(9, " ");
		const latest = task.latestActivity ? ` — ${task.latestActivity}` : "";
		lines.push(`[${task.taskId}] ${status}${latest}`);
	}
	return lines.join("\n");
}

type RunSubagentTaskOptions = {
	signal?: AbortSignal;
	onActivity?: (activity: SubagentActivity) => void;
	steeringInstruction?: string;
	previousOutput?: string;
	steeringNotes?: string[];
};

async function runSubagentTask(
	task: NormalizedSubagentTask,
	defaultCwd: string,
	options?: RunSubagentTaskOptions,
): Promise<SubagentTaskResult> {
	const promptParts = [
		"You are a focused research subagent working for a planning workflow.",
		"Stay read-only. Do not edit files.",
		`Task ID: ${task.id}`,
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
	const args = ["--mode", "json", "--no-session", "-p", prompt];
	const cwd = task.cwd?.trim() ? task.cwd : defaultCwd;
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
		const process = spawn("pi", args, {
			cwd,
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
				process.kill("SIGTERM");
			} catch {
				return;
			}

			forceKillTimer = setTimeout(() => {
				if (closed) {
					return;
				}
				recordActivity("status", "forcing termination");
				try {
					process.kill("SIGKILL");
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

		process.stdout.on("data", (chunk) => {
			stdoutBuffer += chunk.toString();
			const lines = stdoutBuffer.split("\n");
			stdoutBuffer = lines.pop() ?? "";
			for (const line of lines) {
				processLine(line);
			}
		});

		process.stderr.on("data", (chunk) => {
			const text = chunk.toString();
			stderr += text;
			for (const line of text.split("\n")) {
				if (line.trim()) {
					recordActivity("stderr", line);
				}
			}
		});

		process.on("close", (code) => {
			closed = true;
			cleanupAbortHandling();
			if (stdoutBuffer.trim()) {
				processLine(stdoutBuffer);
			}

			recordActivity("status", `finished with exit code ${code ?? 1}`);
			const output = assistantOutputs[assistantOutputs.length - 1] ?? "";
			resolveOnce({
				taskId: task.id,
				task: task.prompt,
				cwd,
				output,
				references: extractReferences(output),
				exitCode: code ?? 1,
				stderr: aborted ? "aborted" : stderr,
				activities,
				startedAt,
				finishedAt: Date.now(),
				steeringNotes: options?.steeringNotes ?? [],
			});
		});

		process.on("error", (error) => {
			cleanupAbortHandling();
			recordActivity("stderr", error.message);
			resolveOnce({
				taskId: task.id,
				task: task.prompt,
				cwd,
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

function formatSubagentDuration(result: SubagentTaskResult): string {
	const durationMs = Math.max(0, result.finishedAt - result.startedAt);
	if (durationMs < 1000) {
		return `${durationMs}ms`;
	}
	return `${(durationMs / 1000).toFixed(1)}s`;
}

function formatSubagentResult(result: SubagentTaskResult, index: number): string {
	const status = result.exitCode === 0 ? "completed" : "failed";
	const header = `Task ${index + 1} (${result.taskId}): ${status}`;
	const output = result.output.trim().length > 0 ? result.output.trim() : "(no output)";
	const refs = result.references.length > 0 ? result.references.map((ref) => `- ${ref}`).join("\n") : "- None";
	const recentActivities = result.activities.slice(-6);
	const activityText =
		recentActivities.length > 0
			? recentActivities.map((activity) => `- ${formatSubagentActivity(activity)}`).join("\n")
			: "- (no activity captured)";

	if (result.exitCode !== 0) {
		const stderr = result.stderr.trim().length > 0 ? result.stderr.trim() : "unknown error";
		return `${header}\nPrompt: ${result.task}\nCWD: ${result.cwd}\nDuration: ${formatSubagentDuration(result)}\nRecent activity:\n${activityText}\nError: ${stderr}`;
	}

	return `${header}\nPrompt: ${result.task}\nCWD: ${result.cwd}\nDuration: ${formatSubagentDuration(result)}\nRecent activity:\n${activityText}\n\n${output}\n\nReferences:\n${refs}`;
}

export function buildSubagentRunDetails(runId: string, results: SubagentTaskResult[]): SubagentRunDetails {
	const successCount = results.filter((result) => result.exitCode === 0).length;
	return {
		runId,
		tasks: results,
		successCount,
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
		default:
			return "○";
	}
}

export function registerSubagentTools(
	pi: ExtensionAPI,
	dependencies: {
		getState: () => PlanModeState;
		subagentsSchema: unknown;
		steerSubagentSchema: unknown;
	},
) {
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
			"Run one or more isolated research subagents in parallel with activity traces and run IDs for follow-up steering.",
		parameters: dependencies.subagentsSchema,
		renderCall(args, theme) {
			const tasks = (args.tasks as SubagentTask[] | undefined) ?? [];
			const lines: string[] = [
				`${theme.fg("toolTitle", theme.bold("subagents "))}${theme.fg("accent", `${tasks.length} task${tasks.length === 1 ? "" : "s"}`)}`,
			];
			for (const task of tasks.slice(0, SUBAGENT_TASK_PREVIEW_LIMIT)) {
				const taskId = task.id?.trim() || "(auto-id)";
				lines.push(`${theme.fg("muted", `- ${taskId}:`)} ${summarizeSnippet(task.prompt, 90)}`);
			}
			if (tasks.length > SUBAGENT_TASK_PREVIEW_LIMIT) {
				lines.push(theme.fg("muted", `... +${tasks.length - SUBAGENT_TASK_PREVIEW_LIMIT} more (Ctrl+O to expand after start)`));
			}
			return createText(lines.join("\n"));
		},
		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details;
			if (isPartial && isSubagentProgressDetails(details)) {
				const lines: string[] = [
					`${theme.fg("toolTitle", theme.bold("subagents "))}${theme.fg("accent", details.runId)} ${theme.fg("muted", `${details.completed}/${details.total}`)}`,
				];
				const visibleTasks = expanded ? details.tasks : details.tasks.slice(0, SUBAGENT_TASK_PREVIEW_LIMIT);
				for (const task of visibleTasks) {
					const status = theme.fg(task.status === "failed" ? "error" : task.status === "completed" ? "success" : "warning", statusIcon(task.status));
					const suffix = task.latestActivity ? ` ${theme.fg("dim", summarizeSnippet(task.latestActivity, 80))}` : "";
					lines.push(`${status} ${theme.fg("accent", task.taskId)} ${theme.fg("muted", task.status)}${suffix}`);
				}
				if (!expanded && details.tasks.length > SUBAGENT_TASK_PREVIEW_LIMIT) {
					lines.push(theme.fg("muted", `... +${details.tasks.length - SUBAGENT_TASK_PREVIEW_LIMIT} more running tasks`));
					lines.push(theme.fg("muted", "Press Ctrl+O to expand and show every task."));
				}
				return createText(lines.join("\n"));
			}

			if (!isSubagentRunDetails(details)) {
				const text = result.content.find((item) => item.type === "text");
				return createText(text?.type === "text" ? text.text : "(no output)");
			}

			const lines: string[] = [
				`${theme.fg("toolTitle", theme.bold("subagents "))}${theme.fg("accent", details.runId)} ${theme.fg("muted", `${details.successCount}/${details.totalCount} succeeded`)}`,
			];
			const visibleTasks = expanded ? details.tasks : details.tasks.slice(0, SUBAGENT_TASK_PREVIEW_LIMIT);
			for (const task of visibleTasks) {
				const statusIconText = task.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
				if (!expanded) {
					lines.push(`${statusIconText} ${theme.fg("accent", task.taskId)} ${theme.fg("muted", summarizeSnippet(task.task, 80))}`);
					continue;
				}

				const taskStatus = task.exitCode === 0 ? theme.fg("success", "completed") : theme.fg("error", "failed");
				lines.push(`${statusIconText} ${theme.fg("accent", task.taskId)} ${taskStatus}`);
				lines.push(...indentMultiline(`Prompt: ${task.task}`, "  "));
				lines.push(`  ${theme.fg("muted", "CWD:")} ${task.cwd}`);
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

				if (task.exitCode !== 0) {
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
				if (details.tasks.length > SUBAGENT_TASK_PREVIEW_LIMIT) {
					lines.push(theme.fg("muted", `... +${details.tasks.length - SUBAGENT_TASK_PREVIEW_LIMIT} more tasks`));
				}
				lines.push(theme.fg("muted", "Press Ctrl+O to expand and show all tasks, outputs, and activity traces."));
			} else {
				lines.push(theme.fg("muted", "Ctrl+O to collapse."));
			}
			return createText(lines.join("\n"));
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<SubagentRunDetails>> {
			if (!dependencies.getState().active) {
				return {
					isError: true,
					content: [{ type: "text", text: "subagents is only available while plan mode is active." }],
				};
			}

			const tasks = normalizeSubagentTasks(params.tasks as SubagentTask[]);
			const concurrency = resolveSubagentConcurrency(params.concurrency);
			if (concurrency === null) {
				return {
					isError: true,
					content: [{ type: "text", text: "concurrency must be an integer between 1 and 4." }],
				};
			}
			const runId = createSubagentRunId();
			let completed = 0;

			const progress: SubagentTaskProgress[] = tasks.map((task) => ({
				taskId: task.id,
				prompt: task.prompt,
				status: "queued",
				activityCount: 0,
			}));

			const emitProgress = () => {
				onUpdate?.({
					content: [{ type: "text", text: buildSubagentProgressText(runId, progress, completed, tasks.length) }],
					details: {
						runId,
						completed,
						total: tasks.length,
						tasks: cloneSubagentProgress(progress),
					} satisfies SubagentProgressDetails,
				});
			};

			emitProgress();

			const results = await runWithConcurrencyLimit(tasks, concurrency, async (task, index) => {
				progress[index] = {
					...progress[index],
					status: "running",
					latestActivity: "started",
				};
				emitProgress();

				const result = await runSubagentTask(task, ctx.cwd, {
					signal,
					onActivity: (activity) => {
						progress[index] = {
							...progress[index],
							latestActivity: formatSubagentActivity(activity),
							activityCount: progress[index].activityCount + 1,
						};
						emitProgress();
					},
				});

				completed += 1;
				progress[index] = {
					...progress[index],
					status: result.exitCode === 0 ? "completed" : "failed",
					latestActivity: `finished (${result.exitCode === 0 ? "ok" : "failed"})`,
				};
				emitProgress();
				return result;
			});

			const details = buildSubagentRunDetails(runId, results);
			rememberSubagentRun({
				runId,
				createdAt: Date.now(),
				tasks: results,
			});

			const formatted = results.map((result, index) => formatSubagentResult(result, index)).join("\n\n---\n\n");
			const summaryHeader = `Subagent research run ${runId}: ${details.successCount}/${details.totalCount} tasks succeeded.`;
			const steeringHint =
				`Use steer_subagent with runId \"${runId}\" and a taskId to rerun a specific task with extra instruction.`;

			return {
				content: [{ type: "text", text: `${summaryHeader}\n${steeringHint}\n\n${formatted}` }],
				details,
				isError: details.successCount !== details.totalCount,
			};
		},
	});

	pi.registerTool({
		name: "steer_subagent",
		label: "steer_subagent",
		description:
			"Rerun one task from a previous subagents run using runId/taskId and an extra steering instruction.",
		parameters: dependencies.steerSubagentSchema,
		renderCall(args, theme) {
			const instruction = summarizeSnippet(args.instruction ?? "", 90);
			const text = `${theme.fg("toolTitle", theme.bold("steer_subagent "))}${theme.fg("accent", `${args.runId}/${args.taskId}`)}\n${theme.fg("muted", instruction)}`;
			return createText(text);
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<SubagentRunDetails>> {
			if (!dependencies.getState().active) {
				return {
					isError: true,
					content: [{ type: "text", text: "steer_subagent is only available while plan mode is active." }],
				};
			}

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
								? `Unknown runId \"${runId}\". Known runIds: ${knownRunIds.join(", ")}`
								: `Unknown runId \"${runId}\". No prior subagent runs are available.`,
						},
					],
				};
			}

			const taskIndex = run.tasks.findIndex((task) => task.taskId === taskId);
			if (taskIndex === -1) {
				const knownTaskIds = run.tasks.map((task) => task.taskId).join(", ");
				return {
					isError: true,
					content: [{ type: "text", text: `Unknown taskId \"${taskId}\" for run ${runId}. Known taskIds: ${knownTaskIds}` }],
				};
			}

			const previousTask = run.tasks[taskIndex];
			onUpdate?.({
				content: [{ type: "text", text: `Steering ${taskId} in ${runId}...` }],
				details: {
					runId,
					completed: run.tasks.filter((task) => task.exitCode === 0).length,
					total: run.tasks.length,
					tasks: run.tasks.map((task, index) => ({
						taskId: task.taskId,
						prompt: task.task,
						status: index === taskIndex ? "running" : task.exitCode === 0 ? "completed" : "failed",
						latestActivity: index === taskIndex ? "re-running with steering" : undefined,
						activityCount: task.activities.length,
					})),
				} satisfies SubagentProgressDetails,
			});

			const steeringNotes = [...previousTask.steeringNotes, instruction];
			const rerunTask: NormalizedSubagentTask = {
				id: previousTask.taskId,
				prompt: previousTask.task,
				cwd: previousTask.cwd,
			};

			const rerunResult = await runSubagentTask(rerunTask, ctx.cwd, {
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
			const summaryHeader = `Steered ${taskId} in run ${runId}. Run status: ${details.successCount}/${details.totalCount} succeeded.`;

			return {
				content: [
					{
						type: "text",
						text: `${summaryHeader}\n\n${formatSubagentResult(rerunResult, taskIndex)}`,
					},
				],
				details,
				isError: rerunResult.exitCode !== 0,
			};
		},
	});
}
