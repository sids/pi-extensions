/**
 * Q&A extraction hook - extracts questions from assistant responses
 *
 * Custom interactive TUI for answering questions.
 *
 * Demonstrates the "prompt generator" pattern with custom TUI:
 * 1. /answer command gets the last assistant message
 * 2. Shows a spinner while extracting questions as structured JSON
 * 3. Presents an interactive TUI to navigate and answer questions
 * 4. Submits the compiled answers when done
 */

import { complete, type Model, type Api, type UserMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { BorderedLoader } from "@mariozechner/pi-coding-agent";
import {
	type Component,
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	truncateToWidth,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	applyTemplate,
	type AnswerDraftSettings,
	type AnswerSettings,
	type AnswerTemplate,
	DEFAULT_DRAFT_SETTINGS,
	DEFAULT_MODEL_PREFERENCES,
	DEFAULT_SYSTEM_PROMPT,
	type ExtractedQuestion,
	type ExtractionResult,
	mergeAnswerSettings,
	normalizeTemplates,
	parseExtractionResult,
	questionsMatch,
} from "./utils";

const DRAFT_ENTRY_TYPE = "answer:draft";
const DRAFT_VERSION = 1;

interface AnswerDraft {
	version: number;
	sourceEntryId: string;
	questions: ExtractedQuestion[];
	answers: string[];
	updatedAt: number;
	state: "draft" | "cleared";
}

interface QnAResult {
	text: string;
	answers: string[];
}

/**
 * Prefer configured extraction models, otherwise fallback to the current model.
 */
async function selectExtractionModel(
	currentModel: Model<Api>,
	modelRegistry: {
		find: (provider: string, modelId: string) => Model<Api> | undefined;
		getApiKey: (model: Model<Api>) => Promise<string | undefined>;
	},
	modelPreferences: { provider: string; id: string }[],
): Promise<Model<Api>> {
	for (const preference of modelPreferences) {
		const model = modelRegistry.find(preference.provider, preference.id);
		if (!model) {
			continue;
		}

		const apiKey = await modelRegistry.getApiKey(model);
		if (apiKey) {
			return model;
		}
	}

	return currentModel;
}

async function readSettingsFile(
	filePath: string,
	ctx: ExtensionContext,
): Promise<Record<string, unknown> | null> {
	try {
		const contents = await fs.readFile(filePath, "utf8");
		return JSON.parse(contents) as Record<string, unknown>;
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === "ENOENT") {
			return null;
		}

		if (ctx.hasUI) {
			ctx.ui.notify(`Failed to read ${filePath}: ${err.message ?? "unknown error"}`, "warning");
		}
		return null;
	}
}

async function loadAnswerSettings(ctx: ExtensionContext): Promise<AnswerSettings> {
	const globalPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
	const projectPath = path.join(ctx.cwd, ".pi", "settings.json");

	const [globalSettings, projectSettings] = await Promise.all([
		readSettingsFile(globalPath, ctx),
		readSettingsFile(projectPath, ctx),
	]);

	const merged = mergeAnswerSettings(
		(globalSettings?.answer as AnswerSettings | undefined) ?? undefined,
		(projectSettings?.answer as AnswerSettings | undefined) ?? undefined,
	);

	return merged;
}

function normalizeDraftAnswers(answers: string[] | undefined, count: number): string[] {
	return Array.from({ length: count }, (_, index) => answers?.[index] ?? "");
}

function getLatestDraft(
	entries: Array<{ type: string; customType?: string; data?: unknown }>,
	sourceEntryId: string,
	questions: ExtractedQuestion[],
): AnswerDraft | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== DRAFT_ENTRY_TYPE) {
			continue;
		}

		const draft = entry.data as AnswerDraft | undefined;
		if (!draft || draft.sourceEntryId !== sourceEntryId) {
			continue;
		}

		if (draft.state === "cleared") {
			return null;
		}

		if (!questionsMatch(draft.questions, questions)) {
			return null;
		}

		return draft;
	}

	return null;
}

function createDraftStore(
	pi: ExtensionAPI,
	base: { sourceEntryId: string; questions: ExtractedQuestion[] },
	settings: Required<AnswerDraftSettings>,
) {
	if (!settings.enabled) {
		return {
			seed: (_answers: string[]) => {},
			schedule: (_answers: string[]) => {},
			flush: () => {},
			clear: () => {},
		};
	}

	let lastAnswers = normalizeDraftAnswers([], base.questions.length);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let lastSignature = "";

	const appendDraft = (answers: string[], state: AnswerDraft["state"], force: boolean = false) => {
		const normalized = normalizeDraftAnswers(answers, base.questions.length);
		const signature = `${state}:${JSON.stringify(normalized)}`;
		if (!force && signature === lastSignature) {
			return;
		}

		lastSignature = signature;
		const payload: AnswerDraft = {
			version: DRAFT_VERSION,
			sourceEntryId: base.sourceEntryId,
			questions: base.questions,
			answers: normalized,
			updatedAt: Date.now(),
			state,
		};

		pi.appendEntry(DRAFT_ENTRY_TYPE, payload);
	};

	const schedule = (answers: string[]) => {
		lastAnswers = normalizeDraftAnswers(answers, base.questions.length);

		if (settings.autosaveMs <= 0) {
			appendDraft(lastAnswers, "draft");
			return;
		}

		if (timer) {
			clearTimeout(timer);
		}

		timer = setTimeout(() => {
			appendDraft(lastAnswers, "draft");
		}, settings.autosaveMs);
	};

	const flush = () => {
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
		appendDraft(lastAnswers, "draft");
	};

	const clear = () => {
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
		appendDraft([], "cleared", true);
	};

	const seed = (answers: string[]) => {
		lastAnswers = normalizeDraftAnswers(answers, base.questions.length);
	};

	return { seed, schedule, flush, clear };
}

/**
 * Interactive Q&A component for answering extracted questions
 */
class QnAComponent implements Component {
	private questions: ExtractedQuestion[];
	private answers: string[];
	private currentIndex: number = 0;
	private editor: Editor;
	private tui: TUI;
	private onDone: (result: QnAResult | null) => void;
	private showingConfirmation: boolean = false;
	private templates: AnswerTemplate[];
	private templateIndex: number = 0;
	private onDraftChange?: (answers: string[]) => void;

	// Cache
	private cachedWidth?: number;
	private cachedLines?: string[];

	// Colors - using proper reset sequences
	private dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
	private bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
	private cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
	private green = (s: string) => `\x1b[32m${s}\x1b[0m`;
	private yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
	private gray = (s: string) => `\x1b[90m${s}\x1b[0m`;

	constructor(
		questions: ExtractedQuestion[],
		tui: TUI,
		onDone: (result: QnAResult | null) => void,
		options?: {
			templates?: AnswerTemplate[];
			initialAnswers?: string[];
			onDraftChange?: (answers: string[]) => void;
		},
	) {
		this.questions = questions;
		this.templates = options?.templates ?? [];
		this.answers = questions.map((_, index) => options?.initialAnswers?.[index] ?? "");
		this.tui = tui;
		this.onDone = onDone;
		this.onDraftChange = options?.onDraftChange;

		// Create a minimal theme for the editor
		const editorTheme: EditorTheme = {
			borderColor: this.dim,
			selectList: {
				selectedBg: (s: string) => `\x1b[44m${s}\x1b[0m`,
				matchHighlight: this.cyan,
				itemSecondary: this.gray,
			},
		};

		this.editor = new Editor(tui, editorTheme);
		// Disable the editor's built-in submit (which clears the editor)
		// We'll handle Enter ourselves to preserve the text
		this.editor.disableSubmit = true;
		this.editor.onChange = () => {
			this.saveCurrentAnswer();
			this.invalidate();
			this.tui.requestRender();
		};

		this.editor.setText(this.answers[this.currentIndex] || "");
	}

	private emitDraftChange(): void {
		this.onDraftChange?.([...this.answers]);
	}

	private saveCurrentAnswer(emit: boolean = true): void {
		this.answers[this.currentIndex] = this.editor.getText();
		if (emit) {
			this.emitDraftChange();
		}
	}

	private navigateTo(index: number): void {
		if (index < 0 || index >= this.questions.length) return;
		this.saveCurrentAnswer();
		this.currentIndex = index;
		this.editor.setText(this.answers[index] || "");
		this.invalidate();
	}

	private applyNextTemplate(): void {
		if (this.templates.length === 0) {
			return;
		}

		const template = this.templates[this.templateIndex];
		const question = this.questions[this.currentIndex];
		const updated = applyTemplate(template.template, {
			question: question.question,
			context: question.context,
			answer: this.editor.getText(),
			index: this.currentIndex,
			total: this.questions.length,
		});

		this.editor.setText(updated);
		this.saveCurrentAnswer();
		this.templateIndex = (this.templateIndex + 1) % this.templates.length;
		this.invalidate();
		this.tui.requestRender();
	}

	private submit(): void {
		this.saveCurrentAnswer();

		// Build the response text (omit unanswered entries)
		const parts: string[] = [];
		for (let i = 0; i < this.questions.length; i++) {
			const q = this.questions[i];
			const rawAnswer = this.answers[i] ?? "";
			const trimmed = rawAnswer.trim();
			if (trimmed.length === 0) {
				continue;
			}
			parts.push(`Q: ${q.question}`);
			parts.push(`A: ${rawAnswer}`);
			parts.push("");
		}

		this.onDone({ text: parts.join("\n").trim(), answers: [...this.answers] });
	}

	private cancel(): void {
		this.onDone(null);
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	handleInput(data: string): void {
		// Handle confirmation dialog
		if (this.showingConfirmation) {
			if (matchesKey(data, Key.enter) || data.toLowerCase() === "y") {
				this.submit();
				return;
			}
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data.toLowerCase() === "n") {
				this.showingConfirmation = false;
				this.invalidate();
				this.tui.requestRender();
				return;
			}
			return;
		}

		// Global navigation and commands
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.cancel();
			return;
		}

		if (matchesKey(data, Key.ctrl("t"))) {
			this.applyNextTemplate();
			return;
		}

		// Tab / Shift+Tab for navigation
		if (matchesKey(data, Key.tab)) {
			if (this.currentIndex < this.questions.length - 1) {
				this.navigateTo(this.currentIndex + 1);
				this.tui.requestRender();
			}
			return;
		}
		if (matchesKey(data, Key.shift("tab"))) {
			if (this.currentIndex > 0) {
				this.navigateTo(this.currentIndex - 1);
				this.tui.requestRender();
			}
			return;
		}

		// Arrow up/down for question navigation when editor is empty
		// (Editor handles its own cursor navigation when there's content)
		if (matchesKey(data, Key.up) && this.editor.getText() === "") {
			if (this.currentIndex > 0) {
				this.navigateTo(this.currentIndex - 1);
				this.tui.requestRender();
				return;
			}
		}
		if (matchesKey(data, Key.down) && this.editor.getText() === "") {
			if (this.currentIndex < this.questions.length - 1) {
				this.navigateTo(this.currentIndex + 1);
				this.tui.requestRender();
				return;
			}
		}

		// Handle Enter ourselves (editor's submit is disabled)
		// Plain Enter moves to next question or shows confirmation on last question
		// Shift+Enter adds a newline (handled by editor)
		if (matchesKey(data, Key.enter) && !matchesKey(data, Key.shift("enter"))) {
			this.saveCurrentAnswer();
			if (this.currentIndex < this.questions.length - 1) {
				this.navigateTo(this.currentIndex + 1);
			} else {
				// On last question - show confirmation
				this.showingConfirmation = true;
			}
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		// Pass to editor
		this.editor.handleInput(data);
		this.invalidate();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const boxWidth = Math.min(width - 4, 120); // Allow wider box
		const contentWidth = boxWidth - 4; // 2 chars padding on each side

		// Helper to create horizontal lines (dim the whole thing at once)
		const horizontalLine = (count: number) => "─".repeat(count);

		// Helper to create a box line
		const boxLine = (content: string, leftPad: number = 2): string => {
			const paddedContent = " ".repeat(leftPad) + content;
			const contentLen = visibleWidth(paddedContent);
			const rightPad = Math.max(0, boxWidth - contentLen - 2);
			return this.dim("│") + paddedContent + " ".repeat(rightPad) + this.dim("│");
		};

		const emptyBoxLine = (): string => {
			return this.dim("│") + " ".repeat(boxWidth - 2) + this.dim("│");
		};

		const padToWidth = (line: string): string => {
			const len = visibleWidth(line);
			return line + " ".repeat(Math.max(0, width - len));
		};

		// Title
		lines.push(padToWidth(this.dim("╭" + horizontalLine(boxWidth - 2) + "╮")));
		const title = `${this.bold(this.cyan("Questions"))} ${this.dim(`(${this.currentIndex + 1}/${this.questions.length})`)}`;
		lines.push(padToWidth(boxLine(title)));
		lines.push(padToWidth(this.dim("├" + horizontalLine(boxWidth - 2) + "┤")));

		// Progress indicator
		const progressParts: string[] = [];
		for (let i = 0; i < this.questions.length; i++) {
			const answered = (this.answers[i]?.trim() || "").length > 0;
			const current = i === this.currentIndex;
			if (current) {
				progressParts.push(this.cyan("●"));
			} else if (answered) {
				progressParts.push(this.green("●"));
			} else {
				progressParts.push(this.dim("○"));
			}
		}
		lines.push(padToWidth(boxLine(progressParts.join(" "))));
		lines.push(padToWidth(emptyBoxLine()));

		// Current question
		const q = this.questions[this.currentIndex];
		const questionText = `${this.bold("Q:")} ${q.question}`;
		const wrappedQuestion = wrapTextWithAnsi(questionText, contentWidth);
		for (const line of wrappedQuestion) {
			lines.push(padToWidth(boxLine(line)));
		}

		// Context if present
		if (q.context) {
			lines.push(padToWidth(emptyBoxLine()));
			const contextText = this.gray(`> ${q.context}`);
			const wrappedContext = wrapTextWithAnsi(contextText, contentWidth - 2);
			for (const line of wrappedContext) {
				lines.push(padToWidth(boxLine(line)));
			}
		}

		lines.push(padToWidth(emptyBoxLine()));

		// Render the editor component (multi-line input) with padding
		// Skip the first and last lines (editor's own border lines)
		const answerPrefix = this.bold("A: ");
		const editorWidth = contentWidth - 4 - 3; // Extra padding + space for "A: "
		const editorLines = this.editor.render(editorWidth);
		for (let i = 1; i < editorLines.length - 1; i++) {
			if (i === 1) {
				// First content line gets the "A: " prefix
				lines.push(padToWidth(boxLine(answerPrefix + editorLines[i])));
			} else {
				// Subsequent lines get padding to align with the first line
				lines.push(padToWidth(boxLine("   " + editorLines[i])));
			}
		}

		lines.push(padToWidth(emptyBoxLine()));

		// Confirmation dialog or footer with controls
		if (this.showingConfirmation) {
			lines.push(padToWidth(this.dim("├" + horizontalLine(boxWidth - 2) + "┤")));
			const confirmMsg = `${this.yellow("Submit all answers?")} ${this.dim("(Enter/y to confirm, Esc/n to cancel)")}`;
			lines.push(padToWidth(boxLine(truncateToWidth(confirmMsg, contentWidth))));
		} else {
			lines.push(padToWidth(this.dim("├" + horizontalLine(boxWidth - 2) + "┤")));
			const templateLabel =
				this.templates.length > 0
					? ` · ${this.dim("Ctrl+T")} template${this.templates.length > 1 ? `: ${this.templates[this.templateIndex].label}` : ""}`
					: "";
			const controls = `${this.dim("Tab/Enter")} next · ${this.dim("Shift+Tab")} prev · ${this.dim("Shift+Enter")} newline${templateLabel} · ${this.dim("Esc")} cancel`;
			lines.push(padToWidth(boxLine(truncateToWidth(controls, contentWidth))));
		}
		lines.push(padToWidth(this.dim("╰" + horizontalLine(boxWidth - 2) + "╯")));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

export default function (pi: ExtensionAPI) {
	const answerHandler = async (ctx: ExtensionContext) => {
		if (!ctx.hasUI) {
			ctx.ui.notify("answer requires interactive mode", "error");
			return;
		}

		if (!ctx.model) {
			ctx.ui.notify("No model selected", "error");
			return;
		}

		const settings = await loadAnswerSettings(ctx);
		const systemPrompt = settings.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
		const modelPreferences = settings.extractionModels ?? DEFAULT_MODEL_PREFERENCES;
		const templates = normalizeTemplates(settings.answerTemplates);
		const draftSettings: Required<AnswerDraftSettings> = {
			...DEFAULT_DRAFT_SETTINGS,
			...(settings.drafts ?? {}),
		};

		// Find the last assistant message on the current branch
		const branch = ctx.sessionManager.getBranch();
		let lastAssistantText: string | undefined;
		let lastAssistantEntryId: string | undefined;

		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type === "message") {
				const msg = entry.message;
				if ("role" in msg && msg.role === "assistant") {
					if (msg.stopReason !== "stop") {
						ctx.ui.notify(`Last assistant message incomplete (${msg.stopReason})`, "error");
						return;
					}
					const textParts = msg.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text);
					if (textParts.length > 0) {
						lastAssistantText = textParts.join("\n");
						lastAssistantEntryId = entry.id;
						break;
					}
				}
			}
		}

		if (!lastAssistantText || !lastAssistantEntryId) {
			ctx.ui.notify("No assistant messages found", "error");
			return;
		}

		// Select the best model for extraction
		const extractionModel = await selectExtractionModel(ctx.model, ctx.modelRegistry, modelPreferences);

		// Run extraction with loader UI
		const extractionResult = await ctx.ui.custom<ExtractionResult | null>((tui, theme, _kb, done) => {
			const loader = new BorderedLoader(tui, theme, `Extracting questions using ${extractionModel.id}...`);
			loader.onAbort = () => done(null);

			const doExtract = async () => {
				const apiKey = await ctx.modelRegistry.getApiKey(extractionModel);
				const userMessage: UserMessage = {
					role: "user",
					content: [{ type: "text", text: lastAssistantText! }],
					timestamp: Date.now(),
				};

				const response = await complete(
					extractionModel,
					{ systemPrompt, messages: [userMessage] },
					{ apiKey, signal: loader.signal },
				);

				if (response.stopReason === "aborted") {
					return null;
				}

				const responseText = response.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n");

				return parseExtractionResult(responseText);
			};

			doExtract()
				.then(done)
				.catch(() => done(null));

			return loader;
		});

		if (extractionResult === null) {
			ctx.ui.notify("Cancelled", "info");
			return;
		}

		if (extractionResult.questions.length === 0) {
			ctx.ui.notify("No questions found in the last message", "info");
			return;
		}

		const draftStore = createDraftStore(
			pi,
			{ sourceEntryId: lastAssistantEntryId, questions: extractionResult.questions },
			draftSettings,
		);

		let initialAnswers = normalizeDraftAnswers([], extractionResult.questions.length);
		const draft = draftSettings.enabled
			? getLatestDraft(branch, lastAssistantEntryId, extractionResult.questions)
			: null;
		if (draft) {
			initialAnswers = normalizeDraftAnswers(draft.answers, extractionResult.questions.length);
			const hasContent = initialAnswers.some((answer) => answer.trim().length > 0);
			if (hasContent && draftSettings.promptOnRestore) {
				const resume = await ctx.ui.confirm(
					"Resume draft answers?",
					"Saved answers were found for this assistant message. Restore them?",
				);
				if (!resume) {
					initialAnswers = normalizeDraftAnswers([], extractionResult.questions.length);
					draftStore.clear();
				}
			}
		}

		draftStore.seed(initialAnswers);

		// Show the Q&A component
		const answersResult = await ctx.ui.custom<QnAResult | null>((tui, _theme, _kb, done) => {
			return new QnAComponent(extractionResult.questions, tui, done, {
				templates,
				initialAnswers,
				onDraftChange: (answers) => draftStore.schedule(answers),
			});
		});

		if (answersResult === null) {
			draftStore.flush();
			ctx.ui.notify("Cancelled", "info");
			return;
		}

		draftStore.clear();

		if (answersResult.text.trim().length === 0) {
			ctx.ui.notify("No answers provided", "info");
			return;
		}

		// Send the answers directly as a message and trigger a turn
		pi.sendMessage(
			{
				customType: "answers",
				content: "I answered your questions in the following way:\n\n" + answersResult.text,
				display: true,
			},
			{ triggerTurn: true },
		);
	};

	pi.registerCommand("answer", {
		description: "Extract questions from last assistant message into interactive Q&A",
		handler: (_args, ctx) => answerHandler(ctx),
	});
}
