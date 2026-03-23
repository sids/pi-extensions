import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type {
	NormalizedSubagentTask,
	ReviewedSubagentTask,
	SubagentThinkingLevel,
} from "./types";

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

		const searchRoots = [
			path.dirname(fileURLToPath(import.meta.url)),
			process.cwd(),
			resolveLaunchReviewAgentDir(),
		];
		for (const searchRoot of searchRoots) {
			const packageDir = findPackageDir(searchRoot, path.join("@mariozechner", "pi-coding-agent"));
			if (packageDir) {
				return require(path.join(packageDir, modulePath));
			}
		}

		return require(path.join(os.homedir(), ".bun", "install", "global", "node_modules", "@mariozechner", "pi-coding-agent", modulePath));
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
			disableSubmit?: boolean;
			onChange?: () => void;
			setText: (text: string) => void;
			getText: () => string;
			render: (width: number) => string[];
			handleInput: (data: string) => void;
		};
		Key: {
			enter: string;
			tab: string;
			escape: string;
			ctrl: (key: string) => string;
			shift: (key: string) => string;
			alt: (key: string) => string;
		};
		matchesKey: (input: string, key: string) => boolean;
		truncateToWidth: (text: string, width: number) => string;
		visibleWidth: (text: string) => number;
		wrapTextWithAnsi: (text: string, width: number) => string[];
	};
}

export const SUBAGENT_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export type SubagentModelOption = {
	value?: string;
	label: string;
	description?: string;
};

export type SubagentThinkingOption = {
	value?: SubagentThinkingLevel;
	label: string;
	description?: string;
};

export function normalizeSubagentCancellationNote(note: string): string | undefined {
	const trimmed = note.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export function createInitialReviewedSubagentTasks(
	tasks: NormalizedSubagentTask[],
	defaultCwd: string,
): ReviewedSubagentTask[] {
	return tasks.map((task) => ({
		taskId: task.id,
		prompt: task.prompt,
		cwd: task.cwd?.trim() ? task.cwd : defaultCwd,
		launchStatus: "ready",
		cancellationNote: undefined,
	}));
}

function formatCurrentModelLabel(currentModelId: string | undefined): string {
	return currentModelId ? `${currentModelId} (current)` : "(no current model)";
}

function formatCurrentThinkingLabel(currentThinkingLevel: SubagentThinkingLevel | undefined): string {
	return currentThinkingLevel ? `${currentThinkingLevel} (current)` : "(unknown thinking)";
}

export function buildSubagentModelOptions(
	models: Array<{ provider: string; id: string; name?: string }>,
	currentModelId?: string,
): SubagentModelOption[] {
	const options: SubagentModelOption[] = [
		{
			label: formatCurrentModelLabel(currentModelId),
			description: "Use the main agent's current model.",
		},
	];
	const seen = new Set<string>();

	for (const model of models) {
		const value = `${model.provider}/${model.id}`;
		if (seen.has(value)) {
			continue;
		}
		seen.add(value);
		options.push({
			value,
			label: value,
			description: model.name && model.name !== value ? model.name : undefined,
		});
	}

	return options;
}

export function buildSubagentThinkingOptions(currentThinkingLevel?: SubagentThinkingLevel): SubagentThinkingOption[] {
	return [
		{
			label: formatCurrentThinkingLabel(currentThinkingLevel),
			description: "Use the main agent's current thinking level.",
		},
		...SUBAGENT_THINKING_LEVELS.map((level) => ({
			value: level,
			label: level,
		})),
	];
}

export function buildSubagentLaunchReviewResult(tasks: ReviewedSubagentTask[]): {
	tasks: ReviewedSubagentTask[];
	readyCount: number;
	cancelledCount: number;
} {
	const normalizedTasks = tasks.map((task) => ({
		...task,
		cancellationNote:
			task.launchStatus === "cancelled"
				? normalizeSubagentCancellationNote(task.cancellationNote ?? "")
				: undefined,
	}));
	const readyCount = normalizedTasks.filter((task) => task.launchStatus === "ready").length;
	return {
		tasks: normalizedTasks,
		readyCount,
		cancelledCount: normalizedTasks.length - readyCount,
	};
}

export function parseSubagentScopedModelPatterns(args: string[]): string[] | undefined {
	for (let index = 0; index < args.length; index++) {
		if (args[index] !== "--models") {
			continue;
		}
		const raw = args[index + 1] ?? "";
		return raw.split(",").map((value) => value.trim()).filter(Boolean);
	}
	return undefined;
}

export function resolveConfiguredSubagentModelPatterns(
	globalSettings: Record<string, unknown> | null,
	projectSettings: Record<string, unknown> | null,
): string[] | undefined {
	const globalPatterns = Array.isArray(globalSettings?.enabledModels)
		? globalSettings.enabledModels.filter((value): value is string => typeof value === "string")
		: undefined;
	const projectPatterns = Array.isArray(projectSettings?.enabledModels)
		? projectSettings.enabledModels.filter((value): value is string => typeof value === "string")
		: undefined;
	return projectPatterns ?? globalPatterns;
}

function cycleOption<T extends { value?: unknown }>(options: T[], currentValue: unknown): T | undefined {
	if (options.length === 0) {
		return undefined;
	}

	const currentIndex = options.findIndex((option) => option.value === currentValue);
	const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % options.length;
	return options[nextIndex];
}

function resolveLaunchReviewAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	const value = env.PI_CODING_AGENT_DIR?.trim();
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

async function readSettingsFile(filePath: string): Promise<Record<string, unknown> | null> {
	try {
		const contents = await readFile(filePath, "utf8");
		return JSON.parse(contents) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function getAvailableModels(ctx: ExtensionContext): Array<{ provider: string; id: string; name?: string }> {
	try {
		const models = ctx.modelRegistry?.getAvailable?.();
		return Array.isArray(models)
			? models.map((model) => ({ provider: model.provider, id: model.id, name: model.name }))
			: [];
	} catch {
		return [];
	}
}

async function getScopedModelPatterns(ctx: ExtensionContext): Promise<string[] | undefined> {
	const cliPatterns = parseSubagentScopedModelPatterns(process.argv.slice(2));
	if (cliPatterns !== undefined) {
		return cliPatterns;
	}

	const [globalSettings, projectSettings] = await Promise.all([
		readSettingsFile(path.join(resolveLaunchReviewAgentDir(), "settings.json")),
		readSettingsFile(path.join(ctx.cwd, ".pi", "settings.json")),
	]);
	return resolveConfiguredSubagentModelPatterns(globalSettings, projectSettings);
}

async function getModelCandidates(ctx: ExtensionContext): Promise<Array<{ provider: string; id: string; name?: string }>> {
	const scopedPatterns = await getScopedModelPatterns(ctx);
	if (scopedPatterns && scopedPatterns.length > 0) {
		try {
			const { resolveModelScope } = requirePiCodingAgentModule("dist/core/model-resolver.js") as {
				resolveModelScope: (
					patterns: string[],
					modelRegistry: ExtensionContext["modelRegistry"],
				) => Promise<Array<{ model: { provider: string; id: string; name?: string } }>>;
			};
			const scopedModels = await resolveModelScope(scopedPatterns, ctx.modelRegistry);
			if (scopedModels.length > 0) {
				return scopedModels.map(({ model }) => ({
					provider: model.provider,
					id: model.id,
					name: model.name,
				}));
			}
		} catch {
			// Fall back to all available models if scope resolution is unavailable.
		}
	}

	return getAvailableModels(ctx);
}

type TuiComponent = {
	handleInput: (data: string) => void;
	render: (width: number) => string[];
	invalidate: () => void;
};

class SubagentLaunchReviewComponent implements TuiComponent {
	private tasks: ReviewedSubagentTask[];
	private currentIndex = 0;
	private showingConfirmation = false;
	private readonly modelOptions: SubagentModelOption[];
	private readonly thinkingOptions: SubagentThinkingOption[];
	private readonly editor: {
		disableSubmit?: boolean;
		onChange?: () => void;
		setText: (text: string) => void;
		getText: () => string;
		render: (width: number) => string[];
		handleInput: (data: string) => void;
	};
	private readonly tui: { requestRender: () => void };
	private readonly onDone: (result: ReviewedSubagentTask[] | null) => void;

	private cachedWidth?: number;
	private cachedLines?: string[];

	private dim = (s: string) => s;
	private bold = (s: string) => s;
	private accent = (s: string) => s;
	private success = (s: string) => s;
	private warning = (s: string) => s;
	private muted = (s: string) => s;

	constructor(
		tasks: ReviewedSubagentTask[],
		modelOptions: SubagentModelOption[],
		thinkingOptions: SubagentThinkingOption[],
		tui: { requestRender: () => void },
		onDone: (result: ReviewedSubagentTask[] | null) => void,
		options?: {
			accentColor?: (text: string) => string;
			successColor?: (text: string) => string;
			warningColor?: (text: string) => string;
			mutedColor?: (text: string) => string;
			dimColor?: (text: string) => string;
			boldText?: (text: string) => string;
		},
	) {
		this.tasks = tasks;
		this.modelOptions = modelOptions;
		this.thinkingOptions = thinkingOptions;
		this.tui = tui;
		this.onDone = onDone;
		this.accent = options?.accentColor ?? this.accent;
		this.success = options?.successColor ?? this.success;
		this.warning = options?.warningColor ?? this.warning;
		this.muted = options?.mutedColor ?? this.muted;
		this.dim = options?.dimColor ?? this.dim;
		this.bold = options?.boldText ?? this.bold;

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
			this.saveCurrentEditorText();
			this.invalidate();
			this.tui.requestRender();
		};
		this.loadCurrentEditorText();
	}

	private getCurrent(): ReviewedSubagentTask | undefined {
		return this.tasks[this.currentIndex];
	}

	private saveCurrentEditorText(): void {
		const current = this.getCurrent();
		if (!current) {
			return;
		}
		if (current.launchStatus === "cancelled") {
			current.cancellationNote = this.editor.getText();
			return;
		}
		current.prompt = this.editor.getText();
	}

	private loadCurrentEditorText(): void {
		const current = this.getCurrent();
		if (!current) {
			this.editor.setText("");
			return;
		}
		this.editor.setText(current.launchStatus === "cancelled" ? current.cancellationNote ?? "" : current.prompt);
	}

	private move(delta: number, wrap: boolean = false): void {
		if (this.tasks.length === 0) {
			return;
		}

		this.saveCurrentEditorText();
		if (wrap) {
			this.currentIndex = (this.currentIndex + delta + this.tasks.length) % this.tasks.length;
		} else {
			const nextIndex = this.currentIndex + delta;
			this.currentIndex = Math.max(0, Math.min(this.tasks.length - 1, nextIndex));
		}
		this.loadCurrentEditorText();
		this.showingConfirmation = false;
		this.invalidate();
		this.tui.requestRender();
	}

	private toggleCancelled(): void {
		const current = this.getCurrent();
		if (!current) {
			return;
		}

		this.saveCurrentEditorText();
		current.launchStatus = current.launchStatus === "cancelled" ? "ready" : "cancelled";
		this.loadCurrentEditorText();
		this.showingConfirmation = false;
		this.invalidate();
		this.tui.requestRender();
	}

	private cycleModel(): void {
		const current = this.getCurrent();
		if (!current) {
			return;
		}

		const next = cycleOption(this.modelOptions, current.modelOverride);
		if (!next) {
			return;
		}

		current.modelOverride = typeof next.value === "string" ? next.value : undefined;
		this.showingConfirmation = false;
		this.invalidate();
		this.tui.requestRender();
	}

	private cycleThinking(): void {
		const current = this.getCurrent();
		if (!current) {
			return;
		}

		const next = cycleOption(this.thinkingOptions, current.thinkingOverride);
		if (!next) {
			return;
		}

		current.thinkingOverride = next.value;
		this.showingConfirmation = false;
		this.invalidate();
		this.tui.requestRender();
	}

	private getModelLabel(modelOverride: string | undefined): string {
		return this.modelOptions.find((option) => option.value === modelOverride)?.label ?? this.modelOptions[0]?.label ?? "(no current model)";
	}

	private getThinkingLabel(thinkingOverride: SubagentThinkingLevel | undefined): string {
		return this.thinkingOptions.find((option) => option.value === thinkingOverride)?.label ?? this.thinkingOptions[0]?.label ?? "(unknown thinking)";
	}

	private submit(): void {
		this.saveCurrentEditorText();
		this.onDone(buildSubagentLaunchReviewResult(this.tasks).tasks);
	}

	invalidate(): void {
		this.cachedLines = undefined;
		this.cachedWidth = undefined;
	}

	handleInput(data: string): void {
		const { Key, matchesKey } = getPiTui();

		if (matchesKey(data, Key.ctrl("c"))) {
			this.onDone(null);
			return;
		}

		if (this.tasks.length === 0) {
			if (matchesKey(data, Key.enter)) {
				this.submit();
			}
			return;
		}

		if (this.showingConfirmation) {
			if (matchesKey(data, Key.enter)) {
				this.submit();
				return;
			}
			if (matchesKey(data, Key.escape)) {
				this.showingConfirmation = false;
				this.invalidate();
				this.tui.requestRender();
			}
			return;
		}

		if (matchesKey(data, Key.ctrl("p"))) {
			this.cycleModel();
			return;
		}

		if (matchesKey(data, Key.shift("tab"))) {
			this.cycleThinking();
			return;
		}

		if (matchesKey(data, Key.tab)) {
			this.move(1, true);
			return;
		}

		if (matchesKey(data, Key.alt("enter"))) {
			this.toggleCancelled();
			return;
		}

		if (matchesKey(data, Key.enter) && !matchesKey(data, Key.shift("enter"))) {
			if (this.currentIndex >= this.tasks.length - 1) {
				this.saveCurrentEditorText();
				this.showingConfirmation = true;
				this.invalidate();
				this.tui.requestRender();
				return;
			}
			this.move(1);
			return;
		}

		this.editor.handleInput(data);
		this.showingConfirmation = false;
		this.invalidate();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const { truncateToWidth, visibleWidth, wrapTextWithAnsi } = getPiTui();
		const lines: string[] = [];
		const safeWidth = Math.max(50, width);
		const margin = " ";
		const lineWidth = Math.max(20, safeWidth - visibleWidth(margin));
		const contentWidth = Math.max(20, lineWidth - 2);
		const padLine = (line: string): string => {
			const truncated = truncateToWidth(line, lineWidth);
			return `${margin}${truncated}${" ".repeat(Math.max(0, lineWidth - visibleWidth(truncated)))}`;
		};
		const wrapMultiline = (text: string, maxWidth: number): string[] => {
			const wrappedLines: string[] = [];
			for (const part of text.split(/\r?\n/)) {
				const wrappedPart = wrapTextWithAnsi(part, Math.max(1, maxWidth));
				if (wrappedPart.length === 0) {
					wrappedLines.push("");
					continue;
				}
				wrappedLines.push(...wrappedPart);
			}
			return wrappedLines;
		};
		const renderEditorLines = () => {
			const editorLines = this.editor.render(Math.max(20, contentWidth));
			for (let index = 1; index < editorLines.length - 1; index++) {
				lines.push(padLine(editorLines[index]!));
			}
		};

		lines.push("");
		if (this.tasks.length === 0) {
			lines.push(padLine("No subagent tasks were provided."));
			lines.push(padLine(this.dim("Press Enter to confirm or Ctrl+C to cancel.")));
			lines.push(padLine(""));
			this.cachedLines = lines;
			this.cachedWidth = width;
			return lines;
		}

		const separator = this.muted(" · ");
		const hint = (shortcut: string, action: string) => `${this.bold(shortcut)} ${this.muted(action)}`;
		const heading = this.bold(this.showingConfirmation ? "Confirm subagent launch" : "Subagent launch review");
		lines.push(padLine(heading));
		lines.push(padLine(this.dim("─".repeat(Math.max(0, lineWidth - 1)))));

		if (this.showingConfirmation) {
			const review = buildSubagentLaunchReviewResult(this.tasks);
			lines.push(padLine(this.muted(`Ready: ${review.readyCount} • Cancelled: ${review.cancelledCount}`)));
			lines.push(padLine(""));

			for (let index = 0; index < review.tasks.length; index++) {
				const task = review.tasks[index]!;
				const icon = task.launchStatus === "cancelled" ? this.warning("⊘") : this.success("✓");
				for (const line of wrapMultiline(`${icon} ${this.accent(task.taskId)} — ${task.prompt}`, contentWidth)) {
					lines.push(padLine(line));
				}
				lines.push(padLine(this.muted(`   CWD: ${task.cwd}`)));
				lines.push(padLine(this.muted(`   Model: ${this.getModelLabel(task.modelOverride)}`)));
				lines.push(padLine(this.muted(`   Thinking: ${this.getThinkingLabel(task.thinkingOverride)}`)));
				if (task.launchStatus === "cancelled" && task.cancellationNote) {
					for (const line of wrapMultiline(`   Note: ${task.cancellationNote}`, contentWidth)) {
						lines.push(padLine(this.muted(line)));
					}
				}
				if (index < review.tasks.length - 1) {
					lines.push(padLine(""));
				}
			}

			lines.push(padLine(this.dim("─".repeat(Math.max(0, lineWidth - 1)))));
			lines.push(padLine([
				hint("Enter", "confirm"),
				hint("Esc", "back"),
				hint("Ctrl+C", "cancel"),
			].join(separator)));
			lines.push(padLine(""));
			this.cachedLines = lines;
			this.cachedWidth = width;
			return lines;
		}

		const current = this.getCurrent();
		if (!current) {
			this.cachedLines = lines;
			this.cachedWidth = width;
			return lines;
		}

		const progressParts = this.tasks.map((task, index) => {
			if (index === this.currentIndex) {
				return this.accent("●");
			}
			return task.launchStatus === "cancelled" ? this.warning("○") : this.success("○");
		});
		lines.push(padLine(progressParts.join(" ")));
		lines.push(padLine(`${this.accent(`Task ${this.currentIndex + 1}/${this.tasks.length}`)}${this.muted(` · ${current.taskId}`)}`));
		lines.push(padLine(`${this.muted("Launch:")} ${current.launchStatus === "cancelled" ? this.warning("cancelled") : this.success("ready")}`));
		lines.push(padLine(`${this.muted("Model:")} ${this.getModelLabel(current.modelOverride)}`));
		lines.push(padLine(`${this.muted("Thinking:")} ${this.getThinkingLabel(current.thinkingOverride)}`));
		lines.push(padLine(""));
		lines.push(padLine(this.muted("CWD:")));
		for (const line of wrapMultiline(current.cwd, contentWidth)) {
			lines.push(padLine(line));
		}
		lines.push(padLine(""));

		if (current.launchStatus === "ready") {
			lines.push(padLine(this.muted("Prompt (editable):")));
			renderEditorLines();
		} else {
			lines.push(padLine(this.muted("Prompt:")));
			for (const line of wrapMultiline(current.prompt, contentWidth)) {
				lines.push(padLine(line));
			}
			lines.push(padLine(""));
			lines.push(padLine(this.muted("Cancellation note:")));
			renderEditorLines();
		}

		lines.push(padLine(this.dim("─".repeat(Math.max(0, lineWidth - 1)))));
		lines.push(padLine([
			hint("Tab", "cycle tasks"),
			hint("Ctrl+P", "cycle model"),
			hint("⇧Tab", "cycle thinking"),
			hint("Alt+Enter", "cancel/restore"),
			hint("Enter", "next/confirm on last"),
			hint("Ctrl+C", "cancel"),
		].join(separator)));
		lines.push(padLine(""));

		this.cachedLines = lines;
		this.cachedWidth = width;
		return lines;
	}
}

export async function runSubagentLaunchReview(
	ctx: ExtensionContext,
	tasks: NormalizedSubagentTask[],
	defaults?: {
		currentModelId?: string;
		currentThinkingLevel?: SubagentThinkingLevel;
	},
): Promise<ReviewedSubagentTask[] | null> {
	if (!ctx.hasUI) {
		return null;
	}

	const reviewedTasks = createInitialReviewedSubagentTasks(tasks, ctx.cwd);
	const modelOptions = buildSubagentModelOptions(await getModelCandidates(ctx), defaults?.currentModelId);
	const thinkingOptions = buildSubagentThinkingOptions(defaults?.currentThinkingLevel);

	return ctx.ui.custom<ReviewedSubagentTask[] | null>((tui, theme, _kb, done) => {
		return new SubagentLaunchReviewComponent(reviewedTasks, modelOptions, thinkingOptions, tui, done, {
			accentColor: (text) => theme.fg("accent", text),
			successColor: (text) => theme.fg("success", text),
			warningColor: (text) => theme.fg("warning", text),
			mutedColor: (text) => theme.fg("muted", text),
			dimColor: (text) => theme.fg("dim", text),
			boldText: (text) => theme.bold(text),
		});
	});
}
