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
	resolveNumericOptionShortcut,
} from "./utils";

const DRAFT_ENTRY_TYPE = "answer:draft";
const DRAFT_VERSION = 2;

interface QuestionResponse {
	selectedOptionIndex: number;
	customText: string;
	selectionTouched: boolean;
	committed: boolean;
}

interface DraftResponse {
	selectedOptionIndex: number;
	customText: string;
	selectionTouched?: boolean;
	committed?: boolean;
}

interface AnswerDraft {
	version: number;
	sourceEntryId: string;
	questions: ExtractedQuestion[];
	answers: string[];
	responses?: DraftResponse[];
	updatedAt: number;
	state: "draft" | "cleared";
}

interface QnAResult {
	text: string;
	answers: string[];
	responses: QuestionResponse[];
}

function getQuestionOptions(question: ExtractedQuestion) {
	return question.options ?? [];
}

function formatResponseAnswer(question: ExtractedQuestion, response: QuestionResponse): string {
	const options = getQuestionOptions(question);
	if (options.length === 0) {
		return response.customText;
	}

	const otherIndex = options.length;
	if (response.selectedOptionIndex === otherIndex) {
		return response.customText;
	}

	if (!response.selectionTouched) {
		return "";
	}

	return options[response.selectedOptionIndex]?.label ?? "";
}

function normalizeResponseForQuestion(
	question: ExtractedQuestion,
	response: Partial<QuestionResponse> | undefined,
	fallbackAnswer: string | undefined,
	inferCommittedFromContent: boolean,
): QuestionResponse {
	const options = getQuestionOptions(question);
	const rawFallback = fallbackAnswer ?? "";
	const rawCustomText = response?.customText ?? rawFallback;
	let selectedOptionIndex =
		typeof response?.selectedOptionIndex === "number" && Number.isFinite(response.selectedOptionIndex)
			? Math.trunc(response.selectedOptionIndex)
			: undefined;
	let selectionTouched = response?.selectionTouched ?? false;

	if (options.length === 0) {
		selectedOptionIndex = 0;
		if (response?.selectionTouched === undefined && rawCustomText.trim().length > 0) {
			selectionTouched = true;
		}
	} else if (selectedOptionIndex === undefined) {
		const fallbackTrimmed = rawFallback.trim();
		if (fallbackTrimmed.length === 0) {
			selectedOptionIndex = 0;
			if (response?.selectionTouched === undefined) {
				selectionTouched = false;
			}
		} else {
			const optionIndex = options.findIndex((option) => option.label === fallbackTrimmed);
			selectedOptionIndex = optionIndex >= 0 ? optionIndex : options.length;
			if (response?.selectionTouched === undefined) {
				selectionTouched = true;
			}
		}
	} else if (response?.selectionTouched === undefined) {
		selectionTouched = response?.committed === true;
		if (!selectionTouched) {
			const fallbackTrimmed = rawFallback.trim();
			if (fallbackTrimmed.length > 0) {
				const optionIndex = options.findIndex((option) => option.label === fallbackTrimmed);
				if (optionIndex >= 0) {
					selectionTouched = optionIndex === selectedOptionIndex && optionIndex !== 0;
				} else {
					selectionTouched = selectedOptionIndex === options.length;
				}
			}
		}
	}

	const maxIndex = options.length;
	const normalizedIndex = Math.max(0, Math.min(maxIndex, selectedOptionIndex ?? 0));
	const useCustomText = options.length === 0 || normalizedIndex === options.length;
	const normalizedCustomText = useCustomText ? rawCustomText : "";

	let committed = response?.committed ?? false;
	if (response?.committed === undefined && inferCommittedFromContent) {
		committed = formatResponseAnswer(question, {
			selectedOptionIndex: normalizedIndex,
			customText: normalizedCustomText,
			selectionTouched,
			committed: false,
		}).trim().length > 0;
	}

	return {
		selectedOptionIndex: normalizedIndex,
		customText: normalizedCustomText,
		selectionTouched,
		committed,
	};
}

function normalizeResponses(
	questions: ExtractedQuestion[],
	responses: Array<Partial<QuestionResponse>> | undefined,
	fallbackAnswers: string[] | undefined,
	inferCommittedFromContent: boolean,
): QuestionResponse[] {
	return questions.map((question, index) =>
		normalizeResponseForQuestion(
			question,
			responses?.[index],
			fallbackAnswers?.[index],
			inferCommittedFromContent,
		),
	);
}

function cloneResponses(responses: QuestionResponse[]): QuestionResponse[] {
	return responses.map((response) => ({ ...response }));
}

function normalizeDraftAnswersFromResponses(
	questions: ExtractedQuestion[],
	responses: QuestionResponse[],
): string[] {
	return questions.map((question, index) => formatResponseAnswer(question, responses[index]));
}

function hasResponseContent(question: ExtractedQuestion, response: QuestionResponse): boolean {
	return formatResponseAnswer(question, response).trim().length > 0;
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
			seed: (_responses: QuestionResponse[]) => {},
			schedule: (_responses: QuestionResponse[]) => {},
			flush: () => {},
			clear: () => {},
		};
	}

	let lastResponses = normalizeResponses(base.questions, undefined, undefined, false);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let lastSignature = "";

	const appendDraft = (responses: QuestionResponse[], state: AnswerDraft["state"], force: boolean = false) => {
		const normalized = normalizeResponses(base.questions, responses, undefined, false);
		const signature = `${state}:${JSON.stringify(normalized)}`;
		if (!force && signature === lastSignature) {
			return;
		}

		lastSignature = signature;
		const payload: AnswerDraft = {
			version: DRAFT_VERSION,
			sourceEntryId: base.sourceEntryId,
			questions: base.questions,
			answers: state === "cleared" ? [] : normalizeDraftAnswersFromResponses(base.questions, normalized),
			responses:
				state === "cleared"
					? []
					: normalized.map((response) => ({
							selectedOptionIndex: response.selectedOptionIndex,
							customText: response.customText,
							selectionTouched: response.selectionTouched,
							committed: response.committed,
						})),
			updatedAt: Date.now(),
			state,
		};

		pi.appendEntry(DRAFT_ENTRY_TYPE, payload);
	};

	const schedule = (responses: QuestionResponse[]) => {
		lastResponses = normalizeResponses(base.questions, responses, undefined, false);

		if (settings.autosaveMs <= 0) {
			appendDraft(lastResponses, "draft");
			return;
		}

		if (timer) {
			clearTimeout(timer);
		}

		timer = setTimeout(() => {
			appendDraft(lastResponses, "draft");
		}, settings.autosaveMs);
	};

	const flush = () => {
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
		appendDraft(lastResponses, "draft");
	};

	const clear = () => {
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
		appendDraft([], "cleared", true);
	};

	const seed = (responses: QuestionResponse[]) => {
		lastResponses = normalizeResponses(base.questions, responses, undefined, false);
	};

	return { seed, schedule, flush, clear };
}

/**
 * Interactive Q&A component for answering extracted questions
 */
class QnAComponent implements Component {
	private questions: ExtractedQuestion[];
	private responses: QuestionResponse[];
	private currentIndex: number = 0;
	private editor: Editor;
	private tui: TUI;
	private onDone: (result: QnAResult | null) => void;
	private showingConfirmation: boolean = false;
	private templates: AnswerTemplate[];
	private templateIndex: number = 0;
	private onDraftChange?: (responses: QuestionResponse[]) => void;

	// Cache
	private cachedWidth?: number;
	private cachedLines?: string[];

	private dim = (s: string) => s;
	private bold = (s: string) => s;
	private italic = (s: string) => `\x1b[3m${s}\x1b[0m`;
	private cyan = (s: string) => s;
	private green = (s: string) => s;
	private yellow = (s: string) => s;
	private gray = (s: string) => s;

	constructor(
		questions: ExtractedQuestion[],
		tui: TUI,
		onDone: (result: QnAResult | null) => void,
		options?: {
			templates?: AnswerTemplate[];
			initialResponses?: QuestionResponse[];
			onDraftChange?: (responses: QuestionResponse[]) => void;
			accentColor?: (text: string) => string;
			successColor?: (text: string) => string;
			warningColor?: (text: string) => string;
			mutedColor?: (text: string) => string;
			dimColor?: (text: string) => string;
			boldText?: (text: string) => string;
			italicText?: (text: string) => string;
		},
	) {
		this.questions = questions;
		this.templates = options?.templates ?? [];
		this.responses = normalizeResponses(questions, options?.initialResponses, undefined, false);
		this.tui = tui;
		this.onDone = onDone;
		this.onDraftChange = options?.onDraftChange;
		this.cyan = options?.accentColor ?? this.cyan;
		this.green = options?.successColor ?? this.green;
		this.yellow = options?.warningColor ?? this.yellow;
		this.gray = options?.mutedColor ?? this.gray;
		this.dim = options?.dimColor ?? this.dim;
		this.bold = options?.boldText ?? this.bold;
		this.italic = options?.italicText ?? this.italic;

		// Create a minimal theme for the editor
		const editorTheme: EditorTheme = {
			borderColor: this.dim,
			selectList: {
				matchHighlight: this.cyan,
				itemSecondary: this.gray,
			},
		};

		this.editor = new Editor(tui, editorTheme);
		// Disable the editor's built-in submit (which clears the editor)
		// We'll handle Enter ourselves to preserve the text
		this.editor.disableSubmit = true;
		this.editor.onChange = () => {
			this.saveCurrentResponse();
			this.invalidate();
			this.tui.requestRender();
		};

		this.loadEditorForCurrentQuestion();
	}

	private getCurrentQuestion(): ExtractedQuestion {
		return this.questions[this.currentIndex];
	}

	private isPrintableInput(data: string): boolean {
		if (data.length !== 1) {
			return false;
		}

		const code = data.charCodeAt(0);
		return code >= 32 && code !== 127;
	}

	private shouldUseEditor(index: number = this.currentIndex): boolean {
		const question = this.questions[index];
		const options = getQuestionOptions(question);
		if (options.length === 0) {
			return true;
		}

		return this.responses[index].selectedOptionIndex === options.length;
	}

	private getCurrentAnswerText(): string {
		const question = this.getCurrentQuestion();
		const response = this.responses[this.currentIndex];
		return formatResponseAnswer(question, response);
	}

	private getAnswerText(index: number): string {
		return formatResponseAnswer(this.questions[index], this.responses[index]);
	}

	private summarizeAnswer(text: string, maxLength: number = 60): string {
		const singleLine = text.replace(/\s+/g, " ").trim();
		if (singleLine.length <= maxLength) {
			return singleLine;
		}
		return `${singleLine.slice(0, maxLength - 1)}…`;
	}

	private emitDraftChange(): void {
		this.onDraftChange?.(cloneResponses(this.responses));
	}

	private loadEditorForCurrentQuestion(): void {
		if (!this.shouldUseEditor()) {
			this.editor.setText("");
			return;
		}

		this.editor.setText(this.responses[this.currentIndex].customText ?? "");
	}

	private saveCurrentResponse(emit: boolean = true): void {
		if (this.shouldUseEditor()) {
			const text = this.editor.getText();
			this.responses[this.currentIndex].customText = text;
			const question = this.questions[this.currentIndex];
			if (getQuestionOptions(question).length === 0 || text.trim().length > 0) {
				this.responses[this.currentIndex].selectionTouched = true;
			}
		}

		if (emit) {
			this.emitDraftChange();
		}
	}

	private navigateTo(index: number): void {
		if (index < 0 || index >= this.questions.length) {
			return;
		}

		this.saveCurrentResponse();
		this.currentIndex = index;
		this.showingConfirmation = false;
		this.loadEditorForCurrentQuestion();
		this.invalidate();
	}

	private selectOption(index: number): void {
		const question = this.getCurrentQuestion();
		const options = getQuestionOptions(question);
		if (options.length === 0) {
			return;
		}

		const maxIndex = options.length;
		const normalized = Math.max(0, Math.min(maxIndex, index));
		const currentResponse = this.responses[this.currentIndex];
		if (normalized === currentResponse.selectedOptionIndex && currentResponse.selectionTouched) {
			return;
		}

		this.saveCurrentResponse(false);
		currentResponse.selectedOptionIndex = normalized;
		currentResponse.selectionTouched = true;
		this.loadEditorForCurrentQuestion();
		this.emitDraftChange();
		this.invalidate();
		this.tui.requestRender();
	}

	private applyNextTemplate(): void {
		if (this.templates.length === 0) {
			return;
		}

		const question = this.getCurrentQuestion();
		const options = getQuestionOptions(question);
		if (options.length > 0 && !this.shouldUseEditor()) {
			this.selectOption(options.length);
		}

		const template = this.templates[this.templateIndex];
		const updated = applyTemplate(template.template, {
			question: question.question,
			context: question.context,
			answer: this.getCurrentAnswerText(),
			index: this.currentIndex,
			total: this.questions.length,
		});

		this.editor.setText(updated);
		this.saveCurrentResponse();
		this.templateIndex = (this.templateIndex + 1) % this.templates.length;
		this.invalidate();
		this.tui.requestRender();
	}

	private submit(): void {
		this.saveCurrentResponse();

		const answers = normalizeDraftAnswersFromResponses(this.questions, this.responses);
		const parts: string[] = [];
		for (let i = 0; i < this.questions.length; i++) {
			const question = this.questions[i];
			const rawAnswer = answers[i] ?? "";
			if (rawAnswer.trim().length === 0) {
				continue;
			}

			parts.push(`Q: ${question.question}`);
			parts.push(`A: ${rawAnswer}`);
			parts.push("");
		}

		this.onDone({
			text: parts.join("\n").trim(),
			answers,
			responses: cloneResponses(this.responses),
		});
	}

	private cancel(): void {
		this.onDone(null);
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	handleInput(data: string): void {
		if (this.showingConfirmation) {
			if (matchesKey(data, Key.enter)) {
				this.submit();
				return;
			}
			if (matchesKey(data, Key.ctrl("c"))) {
				this.cancel();
				return;
			}
			if (matchesKey(data, Key.escape)) {
				this.showingConfirmation = false;
				this.invalidate();
				this.tui.requestRender();
				return;
			}
			return;
		}

		if (matchesKey(data, Key.ctrl("c"))) {
			this.cancel();
			return;
		}

		if (matchesKey(data, Key.ctrl("t"))) {
			this.applyNextTemplate();
			return;
		}

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

		const question = this.getCurrentQuestion();
		const options = getQuestionOptions(question);
		const usingEditor = this.shouldUseEditor();
		if (options.length > 0) {
			const otherIndex = options.length;
			const isOnOther = this.responses[this.currentIndex].selectedOptionIndex === otherIndex;
			const canSwitchFromCustomInput = usingEditor && isOnOther && this.editor.getText().length === 0;
			const allowOptionNavigation = !usingEditor || canSwitchFromCustomInput;

			if (allowOptionNavigation && matchesKey(data, Key.up)) {
				this.selectOption(this.responses[this.currentIndex].selectedOptionIndex - 1);
				return;
			}

			if (allowOptionNavigation && matchesKey(data, Key.down)) {
				this.selectOption(this.responses[this.currentIndex].selectedOptionIndex + 1);
				return;
			}

			const selectedIndex = resolveNumericOptionShortcut(data, otherIndex, usingEditor);
			if (selectedIndex !== null) {
				this.selectOption(selectedIndex);
				return;
			}
		}

		if (matchesKey(data, Key.enter) && !matchesKey(data, Key.shift("enter"))) {
			const currentResponse = this.responses[this.currentIndex];
			if (options.length > 0 && !this.shouldUseEditor() && !currentResponse.selectionTouched) {
				currentResponse.selectionTouched = true;
			}

			this.saveCurrentResponse();
			currentResponse.committed = true;
			this.emitDraftChange();
			if (this.currentIndex < this.questions.length - 1) {
				this.navigateTo(this.currentIndex + 1);
			} else {
				this.showingConfirmation = true;
			}
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		if (this.shouldUseEditor()) {
			this.editor.handleInput(data);
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		if (this.isPrintableInput(data)) {
			this.selectOption(getQuestionOptions(question).length);
			this.editor.handleInput(data);
			this.saveCurrentResponse();
			this.invalidate();
			this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const boxWidth = Math.max(40, Math.min(width - 4, 120));
		const contentWidth = boxWidth - 4;

		const horizontalLine = (count: number) => "─".repeat(count);

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

		const question = this.getCurrentQuestion();
		const response = this.responses[this.currentIndex];
		const options = getQuestionOptions(question);
		const usesEditor = this.shouldUseEditor();

		lines.push(padToWidth(this.dim(`╭${horizontalLine(boxWidth - 2)}╮`)));
		const title = `Questions ${this.dim(`(${this.currentIndex + 1}/${this.questions.length})`)}`;
		lines.push(padToWidth(boxLine(title)));
		lines.push(padToWidth(this.dim(`├${horizontalLine(boxWidth - 2)}┤`)));

		const progressParts: string[] = [];
		for (let i = 0; i < this.questions.length; i++) {
			const current = i === this.currentIndex;
			const answered = hasResponseContent(this.questions[i], this.responses[i]);
			if (current) {
				progressParts.push(this.cyan("●"));
			} else if (answered) {
				progressParts.push(this.green("●"));
			} else {
				progressParts.push(this.dim("○"));
			}
		}
		lines.push(padToWidth(boxLine(progressParts.join(" "))));

		if (!this.showingConfirmation) {
			if (question.header) {
				lines.push(padToWidth(boxLine(this.cyan(question.header))));
			}
			lines.push(padToWidth(emptyBoxLine()));

			const wrappedQuestion = wrapTextWithAnsi(`${this.bold("Q:")} ${this.bold(question.question)}`, contentWidth);
			for (const line of wrappedQuestion) {
				lines.push(padToWidth(boxLine(line)));
			}

			if (question.context) {
				lines.push(padToWidth(emptyBoxLine()));
				for (const line of wrapTextWithAnsi(this.gray(`> ${question.context}`), contentWidth - 2)) {
					lines.push(padToWidth(boxLine(line)));
				}
			}

			if (options.length > 0) {
				lines.push(padToWidth(emptyBoxLine()));
				for (let i = 0; i <= options.length; i++) {
					const isOther = i === options.length;
					const optionLabel = isOther ? "Other" : options[i].label;
					const description = isOther ? "Type your own answer" : options[i].description;
					const selected = response.selectedOptionIndex === i;
					const marker = selected ? "▶" : " ";
					const optionPrefix = `${marker} ${i + 1}. `;
					const line = `${optionPrefix}${optionLabel}`;
					const styledLine = selected
						? response.selectionTouched
							? this.green(line)
							: this.cyan(line)
						: line;
					lines.push(padToWidth(boxLine(truncateToWidth(styledLine, contentWidth))));

					if (selected && description && description.trim().length > 0) {
						const descriptionIndent = " ".repeat(visibleWidth(optionPrefix));
						const wrappedDescription = wrapTextWithAnsi(
							description,
							Math.max(10, contentWidth - visibleWidth(descriptionIndent)),
						);
						for (const wrapped of wrappedDescription) {
							lines.push(padToWidth(boxLine(`${descriptionIndent}${this.gray(wrapped)}`)));
						}
					}
				}
			}

			lines.push(padToWidth(emptyBoxLine()));
			if (usesEditor) {
				const answerPrefix = this.bold("A: ");
				const editorWidth = Math.max(20, contentWidth - 7);
				const editorLines = this.editor.render(editorWidth);
				for (let i = 1; i < editorLines.length - 1; i++) {
					if (i === 1) {
						lines.push(padToWidth(boxLine(answerPrefix + editorLines[i])));
					} else {
						lines.push(padToWidth(boxLine("   " + editorLines[i])));
					}
				}
			} else {
				const selectedLabel = response.selectionTouched
					? options[response.selectedOptionIndex]?.label ?? ""
					: this.dim("(select an option)");
				lines.push(padToWidth(boxLine(`${this.bold("A:")} ${selectedLabel}`)));
			}
			lines.push(padToWidth(emptyBoxLine()));
		}

		if (this.showingConfirmation) {
			lines.push(padToWidth(this.dim(`├${horizontalLine(boxWidth - 2)}┤`)));
			lines.push(padToWidth(boxLine(this.bold("Review before submit:"))));
			for (let i = 0; i < this.questions.length; i++) {
				const summaryLabel = this.questions[i].header?.trim() || this.questions[i].question;
				const answerText = this.getAnswerText(i);
				const hasAnswer = answerText.trim().length > 0;
				const answerPreview = hasAnswer
					? this.green(this.summarizeAnswer(answerText))
					: this.yellow("(no answer)");
				const questionLine = `${this.bold(`${i + 1}.`)} ${this.cyan(summaryLabel)}`;
				const answerLine = `   ${this.dim("Answer:")} ${answerPreview}`;
				lines.push(padToWidth(boxLine(truncateToWidth(questionLine, contentWidth))));
				lines.push(padToWidth(boxLine(truncateToWidth(answerLine, contentWidth))));
			}
			lines.push(padToWidth(emptyBoxLine()));
			const confirmMsg = `${this.yellow("Submit all answers?")} ${this.dim("(Enter submit, Esc keep editing)")}`;
			lines.push(padToWidth(boxLine(truncateToWidth(confirmMsg, contentWidth))));
			const separator = this.cyan(" · ");
			const formatHint = (shortcut: string, action: string) => `${this.bold(shortcut)} ${this.italic(action)}`;
			const confirmControls = `${formatHint("Enter", "submit")}${separator}${formatHint("Esc", "back")}${separator}${formatHint("Ctrl+C", "cancel")}`;
			lines.push(padToWidth(boxLine(truncateToWidth(confirmControls, contentWidth))));
		} else {
			lines.push(padToWidth(this.dim(`├${horizontalLine(boxWidth - 2)}┤`)));

			const separator = this.cyan(" · ");
			const formatHint = (shortcut: string, action: string) => `${this.bold(shortcut)} ${this.italic(action)}`;
			const joinHints = (parts: string[]) => parts.join(separator);
			const canFit = (parts: string[]) => visibleWidth(joinHints(parts)) <= contentWidth;

			const tabHint = formatHint("Tab/⬆Tab", "next/prev");
			const enterHint = formatHint("Enter", "commit + next");
			const cancelHint = formatHint("Ctrl+C", "cancel");

			const optionalHints: string[] = [];
			if (options.length > 0 && !usesEditor) {
				optionalHints.push(formatHint("↑/↓/1-9", "pick option"));
			}
			if (usesEditor) {
				optionalHints.push(formatHint("⬆Enter", "newline"));
			}
			if (this.templates.length > 0) {
				optionalHints.push(formatHint("Ctrl+T", "template"));
			}

			const trailingHints = [enterHint, tabHint, cancelHint];
			const controls: string[] = [];
			for (const hint of optionalHints) {
				if (canFit([...controls, hint, ...trailingHints])) {
					controls.push(hint);
				}
			}
			controls.push(...trailingHints);

			lines.push(padToWidth(boxLine(truncateToWidth(joinHints(controls), contentWidth))));
		}
		lines.push(padToWidth(this.dim(`╰${horizontalLine(boxWidth - 2)}╯`)));

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

		let initialResponses = normalizeResponses(extractionResult.questions, undefined, undefined, false);
		const draft = draftSettings.enabled
			? getLatestDraft(branch, lastAssistantEntryId, extractionResult.questions)
			: null;
		if (draft) {
			initialResponses = normalizeResponses(
				extractionResult.questions,
				draft.responses as QuestionResponse[] | undefined,
				draft.answers,
				true,
			);
			const hasContent = initialResponses.some((response, index) =>
				hasResponseContent(extractionResult.questions[index], response),
			);
			if (hasContent && draftSettings.promptOnRestore) {
				const resume = await ctx.ui.confirm(
					"Resume draft answers?",
					"Saved answers were found for this assistant message. Restore them?",
				);
				if (!resume) {
					initialResponses = normalizeResponses(extractionResult.questions, undefined, undefined, false);
					draftStore.clear();
				}
			}
		}

		draftStore.seed(initialResponses);

		// Show the Q&A component
		const answersResult = await ctx.ui.custom<QnAResult | null>((tui, theme, _kb, done) => {
			return new QnAComponent(extractionResult.questions, tui, done, {
				templates,
				initialResponses,
				onDraftChange: (responses) => draftStore.schedule(responses),
				accentColor: (text) => theme.fg("accent", text),
				successColor: (text) => theme.fg("success", text),
				warningColor: (text) => theme.fg("warning", text),
				mutedColor: (text) => theme.fg("muted", text),
				dimColor: (text) => theme.fg("dim", text),
				boldText: (text) => theme.bold(text),
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
