import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { SubagentDashboardRunState, SubagentDashboardTaskState, SubagentTranscriptEntry } from "./types";

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

function findPackageDir(startDir: string, packageName: string): string | undefined {
	let currentDir = path.resolve(startDir);
	while (true) {
		const candidate = path.join(currentDir, "node_modules", packageName);
		if (existsSync(candidate)) {
			return candidate;
		}
		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) {
			return undefined;
		}
		currentDir = parentDir;
	}
}

function requirePiCodingAgentModule(modulePath: string) {
	try {
		return require(`@mariozechner/pi-coding-agent/${modulePath}`);
	} catch (error) {
		const code = (error as { code?: string }).code;
		if (code !== "MODULE_NOT_FOUND" && code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") {
			throw error;
		}

		const searchRoots = [path.dirname(fileURLToPath(import.meta.url)), process.cwd()];
		for (const searchRoot of searchRoots) {
			const packageDir = findPackageDir(searchRoot, path.join("@mariozechner", "pi-coding-agent"));
			if (packageDir) {
				return require(path.join(packageDir, modulePath));
			}
		}

		return require(
			path.join(os.homedir(), ".bun", "install", "global", "node_modules", "@mariozechner", "pi-coding-agent", modulePath),
		);
	}
}

function getPiTui() {
	return requirePiTui() as {
		Editor: new (
			tui: { requestRender: () => void },
			theme: {
				borderColor: (text: string) => string;
				selectList: {
					matchHighlight?: (text: string) => string;
					itemSecondary?: (text: string) => string;
				};
			},
		) => {
			focused?: boolean;
			disableSubmit?: boolean;
			onChange?: () => void;
			setText: (text: string) => void;
			getText: () => string;
			render: (width: number) => string[];
			handleInput: (data: string) => void;
		};
		Key: {
			tab: string;
			enter: string;
			escape: string;
			ctrl: (key: string) => string;
			shift: (key: string) => string;
		};
		matchesKey: (input: string, key: string) => boolean;
		truncateToWidth: (text: string, width: number) => string;
		visibleWidth: (text: string) => number;
		wrapTextWithAnsi: (text: string, width: number) => string[];
	};
}

function getPiCodingAgentUi() {
	return requirePiCodingAgentModule("dist/index.js") as {
		AssistantMessageComponent: new (
			message?: any,
			hideThinkingBlock?: boolean,
			markdownTheme?: unknown,
		) => {
			render: (width: number) => string[];
			invalidate: () => void;
		};
		ToolExecutionComponent: new (
			toolName: string,
			args: any,
			options: { showImages?: boolean } | undefined,
			toolDefinition: unknown,
			ui: { requestRender: () => void },
			cwd?: string,
		) => {
			setArgsComplete: () => void;
			updateResult: (result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; details?: any; isError: boolean }, isPartial?: boolean) => void;
			setExpanded: (expanded: boolean) => void;
			render: (width: number) => string[];
			invalidate: () => void;
		};
		getMarkdownTheme: () => unknown;
	};
}

type SteeringEditorTui = {
	requestRender: () => void;
};

type ThemeCallbacks = {
	accentColor?: (text: string) => string;
	mutedColor?: (text: string) => string;
	dimColor?: (text: string) => string;
	successColor?: (text: string) => string;
	warningColor?: (text: string) => string;
	errorColor?: (text: string) => string;
	boldText?: (text: string) => string;
};

type LatestRenderBlock =
	| {
			kind: "assistant";
			message: Extract<SubagentTranscriptEntry, { kind: "assistantMessage" }>["message"];
	  }
	| {
			kind: "toolExecution";
			toolName: string;
			args: unknown;
			result?: Extract<SubagentTranscriptEntry, { kind: "toolResultMessage" }>["message"];
	  }
	| {
			kind: "status" | "stderr";
			text: string;
	  };

function statusIcon(status: SubagentDashboardTaskState["status"]): string {
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

function summarize(text: string, maxLength: number): string {
	const singleLine = text.replace(/\s+/g, " ").trim();
	if (!singleLine) {
		return "";
	}
	if (singleLine.length <= maxLength) {
		return singleLine;
	}
	return `${singleLine.slice(0, Math.max(0, maxLength - 3))}...`;
}

function trimBlankLines(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && lines[start]!.trim().length === 0) {
		start += 1;
	}
	while (end > start && lines[end - 1]!.trim().length === 0) {
		end -= 1;
	}
	return lines.slice(start, end);
}

function indentLines(lines: string[], indent: string): string[] {
	return lines.map((line) => `${indent}${line}`);
}

function formatDuration(task: Pick<SubagentDashboardTaskState, "startedAt" | "finishedAt">): string {
	if (task.startedAt === null || task.finishedAt === null) {
		return "not started";
	}
	const durationMs = Math.max(0, task.finishedAt - task.startedAt);
	if (durationMs < 1000) {
		return `${durationMs}ms`;
	}
	return `${(durationMs / 1000).toFixed(1)}s`;
}

function formatActivityText(text: string): string {
	return text.trim().length > 0 ? text : "(no activity captured)";
}

export function buildLatestRenderBlock(task: SubagentDashboardTaskState): LatestRenderBlock | undefined {
	const toolResultsById = new Map<string, Extract<SubagentTranscriptEntry, { kind: "toolResultMessage" }>['message']>();
	for (const entry of task.transcript) {
		if (entry.kind === "toolResultMessage") {
			toolResultsById.set(entry.message.toolCallId, entry.message);
		}
	}

	const consumedToolResultIds = new Set<string>();
	const blocks: LatestRenderBlock[] = [];
	for (const entry of task.transcript) {
		if (entry.kind === "assistantMessage") {
			const hasVisibleAssistantContent = entry.message.content.some((part) => {
				if (part.type === "text") {
					return part.text.trim().length > 0;
				}
				if (part.type === "thinking") {
					return part.thinking.trim().length > 0;
				}
				return false;
			});
			if (hasVisibleAssistantContent) {
				blocks.push({ kind: "assistant", message: entry.message });
			}
			for (const part of entry.message.content) {
				if (part.type !== "toolCall") {
					continue;
				}
				const result = toolResultsById.get(part.id);
				if (result) {
					consumedToolResultIds.add(result.toolCallId);
				}
				blocks.push({
					kind: "toolExecution",
					toolName: part.name || "unknown_tool",
					args: part.arguments,
					result,
				});
			}
		}
	}

	for (const entry of task.transcript) {
		if (entry.kind !== "toolResultMessage" || consumedToolResultIds.has(entry.message.toolCallId)) {
			continue;
		}
		blocks.push({
			kind: "toolExecution",
			toolName: entry.message.toolName,
			args: {},
			result: entry.message,
		});
	}

	if (blocks.length > 0) {
		return blocks[blocks.length - 1];
	}

	for (let index = task.transcript.length - 1; index >= 0; index -= 1) {
		const entry = task.transcript[index]!;
		if (entry.kind === "status" || entry.kind === "stderr") {
			return {
				kind: entry.kind,
				text: entry.text,
			};
		}
	}
	return undefined;
}

export function renderLatestBlock(task: SubagentDashboardTaskState, width: number): string[] {
	const block = buildLatestRenderBlock(task);
	if (!block) {
		return ["(No updates yet.)"];
	}

	const { AssistantMessageComponent, ToolExecutionComponent, getMarkdownTheme } = getPiCodingAgentUi();
	if (block.kind === "assistant") {
		const component = new AssistantMessageComponent(block.message, false, getMarkdownTheme());
		return trimBlankLines(component.render(width));
	}
	if (block.kind === "toolExecution") {
		const component = new ToolExecutionComponent(block.toolName, block.args, { showImages: false }, undefined, { requestRender: () => {} }, task.cwd);
		component.setArgsComplete();
		component.setExpanded(true);
		if (block.result) {
			component.updateResult(
				{
					content: block.result.content,
					details: block.result.details,
					isError: block.result.isError,
				},
				false,
			);
		}
		return trimBlankLines(component.render(width));
	}
	if (block.kind === "stderr") {
		return [`! ${block.text}`];
	}
	return [`• ${block.text}`];
}

function renderTaskTabs(
	tasks: SubagentDashboardTaskState[],
	selectedTaskId: string | undefined,
	width: number,
	styles: Required<Pick<ThemeCallbacks, "accentColor" | "mutedColor" | "dimColor">>,
): string[] {
	const { wrapTextWithAnsi } = getPiTui();
	const joined = tasks
		.map((task) => {
			const label = `${statusIcon(task.status)} ${task.taskId}`;
			return task.taskId === selectedTaskId ? styles.accentColor(`[ ${label} ]`) : styles.mutedColor(`  ${label}  `);
		})
		.join(styles.dimColor(" "));
	const wrapped = wrapTextWithAnsi(joined, Math.max(1, width));
	return wrapped.length > 0 ? wrapped : [joined];
}

export class SubagentSteeringEditorComponent {
	private readonly editor: {
		focused?: boolean;
		disableSubmit?: boolean;
		onChange?: () => void;
		setText: (text: string) => void;
		getText: () => string;
		render: (width: number) => string[];
		handleInput: (data: string) => void;
	};
	private readonly tui: SteeringEditorTui;
	private readonly getRunState: () => SubagentDashboardRunState | undefined;
	private readonly getSelectedTaskId: () => string | undefined;
	private readonly setSelectedTaskId: (taskId: string) => void;
	private readonly getDraft: (taskId: string) => string;
	private readonly setDraft: (taskId: string, draft: string) => void;
	private readonly submitDraft: (taskId: string, draft: string) => Promise<void>;
	private readonly close: () => void;
	private readonly unsubscribe: () => void;
	private readonly getStatusMessage: () => string | undefined;
	private cachedWidth?: number;
	private cachedLines?: string[];
	private _focused = false;
	private accent = (text: string) => text;
	private muted = (text: string) => text;
	private dim = (text: string) => text;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.editor.focused = value;
	}

	constructor(
		tui: SteeringEditorTui,
		styles: ThemeCallbacks,
		options: {
			getRunState: () => SubagentDashboardRunState | undefined;
			getSelectedTaskId: () => string | undefined;
			setSelectedTaskId: (taskId: string) => void;
			getDraft: (taskId: string) => string;
			setDraft: (taskId: string, draft: string) => void;
			submitDraft: (taskId: string, draft: string) => Promise<void>;
			close: () => void;
			subscribe: (listener: () => void) => () => void;
			getStatusMessage: () => string | undefined;
		},
	) {
		this.tui = tui;
		this.getRunState = options.getRunState;
		this.getSelectedTaskId = options.getSelectedTaskId;
		this.setSelectedTaskId = options.setSelectedTaskId;
		this.getDraft = options.getDraft;
		this.setDraft = options.setDraft;
		this.submitDraft = options.submitDraft;
		this.close = options.close;
		this.getStatusMessage = options.getStatusMessage;
		this.accent = styles.accentColor ?? this.accent;
		this.muted = styles.mutedColor ?? this.muted;
		this.dim = styles.dimColor ?? this.dim;

		const { Editor } = getPiTui();
		this.editor = new Editor(tui, {
			borderColor: this.dim,
			selectList: {
				matchHighlight: this.accent,
				itemSecondary: this.muted,
			},
		});
		this.editor.disableSubmit = true;
		this.editor.onChange = () => {
			this.saveDraft();
			this.invalidate();
			this.tui.requestRender();
		};
		this.loadDraft();
		this.unsubscribe = options.subscribe(() => {
			this.syncSelectedTask();
			this.invalidate();
			this.tui.requestRender();
		});
	}

	dispose(): void {
		this.unsubscribe();
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	getText(): string {
		return this.editor.getText();
	}

	setText(text: string): void {
		this.editor.setText(text);
	}

	private getTasks(): SubagentDashboardTaskState[] {
		return this.getRunState()?.tasks ?? [];
	}

	private getCurrentTask(): SubagentDashboardTaskState | undefined {
		const tasks = this.getTasks();
		if (tasks.length === 0) {
			return undefined;
		}
		const selectedTaskId = this.getSelectedTaskId();
		return tasks.find((task) => task.taskId === selectedTaskId) ?? tasks[0];
	}

	private syncSelectedTask(): void {
		const currentTask = this.getCurrentTask();
		if (!currentTask) {
			this.editor.setText("");
			return;
		}
		if (this.getSelectedTaskId() !== currentTask.taskId) {
			this.setSelectedTaskId(currentTask.taskId);
		}
		this.loadDraft();
	}

	private saveDraft(): void {
		const currentTask = this.getCurrentTask();
		if (!currentTask) {
			return;
		}
		this.setDraft(currentTask.taskId, this.editor.getText());
	}

	private loadDraft(): void {
		const currentTask = this.getCurrentTask();
		this.editor.setText(currentTask ? this.getDraft(currentTask.taskId) : "");
	}

	private switchTask(delta: number): void {
		const tasks = this.getTasks();
		if (tasks.length === 0) {
			return;
		}
		this.saveDraft();
		const currentIndex = Math.max(0, tasks.findIndex((task) => task.taskId === this.getCurrentTask()?.taskId));
		const nextIndex = (currentIndex + delta + tasks.length) % tasks.length;
		this.setSelectedTaskId(tasks[nextIndex]!.taskId);
		this.loadDraft();
		this.invalidate();
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		const { Key, matchesKey } = getPiTui();
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.close();
			return;
		}
		if (matchesKey(data, Key.enter) && !matchesKey(data, Key.shift("enter"))) {
			const currentTask = this.getCurrentTask();
			if (!currentTask) {
				return;
			}
			this.saveDraft();
			void this.submitDraft(currentTask.taskId, this.editor.getText());
			return;
		}
		if (matchesKey(data, Key.tab)) {
			this.switchTask(1);
			return;
		}
		if (matchesKey(data, Key.shift("tab"))) {
			this.switchTask(-1);
			return;
		}
		this.editor.handleInput(data);
		this.invalidate();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const currentTask = this.getCurrentTask();
		const editorLines = this.editor.render(Math.max(20, width));
		const tabLines = renderTaskTabs(this.getTasks(), currentTask?.taskId, Math.max(20, width), {
			accentColor: this.accent,
			mutedColor: this.muted,
			dimColor: this.dim,
		});
		const statusMessage = this.getStatusMessage();
		const lines = [
			...tabLines,
			...editorLines,
			...(statusMessage ? [statusMessage] : []),
			this.dim("Tab/Shift+Tab switch tasks · Enter submit · Shift+Enter newline · Esc close"),
		];
		this.cachedLines = lines;
		this.cachedWidth = width;
		return lines;
	}
}

export function createSubagentInspectorResultComponent(
	options: ThemeCallbacks & {
		runId: string;
		getRunState: () => SubagentDashboardRunState | undefined;
		getSelectedTaskId: () => string | undefined;
	},
) {
	const accent = options.accentColor ?? ((text: string) => text);
	const muted = options.mutedColor ?? ((text: string) => text);
	const dim = options.dimColor ?? ((text: string) => text);
	const wrapText = (text: string, width: number) => {
		const { wrapTextWithAnsi } = getPiTui();
		const wrapped = wrapTextWithAnsi(text, Math.max(1, width));
		return wrapped.length > 0 ? wrapped : [""];
	};

	return {
		render(width: number): string[] {
			const run = options.getRunState();
			if (!run || run.runId !== options.runId || run.tasks.length === 0) {
				return ["(No subagent inspector state available.)"];
			}
			const selectedTaskId = options.getSelectedTaskId();
			const task = run.tasks.find((entry) => entry.taskId === selectedTaskId) ?? run.tasks[0]!;
			const latestBlock = buildLatestRenderBlock(task);
			const output = task.output.trim();
			const shouldRenderLatestBlock =
				latestBlock !== undefined && (latestBlock.kind === "toolExecution" || task.status === "running" || output.length === 0);
			const lines: string[] = [];
			lines.push(`${muted("Subagent:")} ${accent(task.taskId)} ${muted(task.status)}`);
			lines.push(...indentLines(wrapText(`Prompt: ${task.prompt}`, width), "  "));
			lines.push(`  ${muted("CWD:")} ${task.cwd}`);
			lines.push(`  ${muted("Duration:")} ${formatDuration(task)}`);
			lines.push(`  ${muted("Activity:")}`);
			lines.push(`    ${dim(formatActivityText(task.latestActivity ?? "(no activity captured)"))}`);
			if (shouldRenderLatestBlock) {
				lines.push(`  ${muted(latestBlock?.kind === "toolExecution" ? "Latest tool call:" : "Latest update:")}`);
				lines.push(...indentLines(renderLatestBlock(task, Math.max(20, width - 4)), "    "));
			} else {
				lines.push(`  ${muted("Output:")}`);
				lines.push(...indentLines(wrapText(output.length > 0 ? output : "(no output)", Math.max(20, width - 4)), "    "));
			}
			return lines;
		},
		invalidate() {},
	};
}

export async function openSubagentRuntimeDashboard(
	_ctx: ExtensionContext,
	_options: unknown,
): Promise<void> {
	throw new Error("openSubagentRuntimeDashboard is no longer used.");
}
