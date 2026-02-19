import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	cloneResponses,
	deriveAnswersFromResponses,
	hasResponseContent,
	normalizeResponses,
	QnATuiComponent,
	type QnAResponse,
	type QnAResult,
} from "../shared/qna-tui";
import {
	applyTemplate,
	type AnswerDraftSettings,
	type AnswerTemplate,
	type ExtractedQuestion,
	questionsMatch,
	resolveNumericOptionShortcut,
} from "./utils";

const DRAFT_ENTRY_TYPE = "answer:draft";
const DRAFT_VERSION = 2;

interface DraftResponse {
	selectedOptionIndex: number;
	customText: string;
	selectionTouched?: boolean;
	committed?: boolean;
}

export interface AnswerDraft {
	version: number;
	sourceEntryId: string;
	questions: ExtractedQuestion[];
	answers: string[];
	responses?: DraftResponse[];
	updatedAt: number;
	state: "draft" | "cleared";
}

export function getLatestDraft(
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

export function createDraftStore(
	pi: ExtensionAPI,
	base: { sourceEntryId: string; questions: ExtractedQuestion[] },
	settings: Required<AnswerDraftSettings>,
) {
	if (!settings.enabled) {
		return {
			seed: (_responses: QnAResponse[]) => {},
			schedule: (_responses: QnAResponse[]) => {},
			flush: () => {},
			clear: () => {},
		};
	}

	let lastResponses = normalizeResponses(base.questions, undefined, undefined, false);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let lastSignature = "";

	const appendDraft = (responses: QnAResponse[], state: AnswerDraft["state"], force: boolean = false) => {
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
			answers: state === "cleared" ? [] : deriveAnswersFromResponses(base.questions, normalized),
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

	const schedule = (responses: QnAResponse[]) => {
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

	const seed = (responses: QnAResponse[]) => {
		lastResponses = normalizeResponses(base.questions, responses, undefined, false);
	};

	return { seed, schedule, flush, clear };
}

export function getInitialResponses(
	questions: ExtractedQuestion[],
	draft: AnswerDraft | null,
): QnAResponse[] {
	if (!draft) {
		return normalizeResponses(questions, undefined, undefined, false);
	}

	return normalizeResponses(
		questions,
		draft.responses as QnAResponse[] | undefined,
		draft.answers,
		true,
	);
}

export function hasAnyDraftContent(questions: ExtractedQuestion[], responses: QnAResponse[]): boolean {
	return responses.some((response, index) => hasResponseContent(questions[index], response));
}

export async function collectAnswers(
	ctx: ExtensionContext,
	questions: ExtractedQuestion[],
	options: {
		templates: AnswerTemplate[];
		initialResponses: QnAResponse[];
		onDraftChange: (responses: QnAResponse[]) => void;
	},
): Promise<QnAResult | null> {
	return await ctx.ui.custom<QnAResult | null>((tui, theme, _kb, done) => {
		return new QnATuiComponent(questions, tui, done, {
			templates: options.templates,
			initialResponses: options.initialResponses,
			onResponsesChange: (responses) => options.onDraftChange(cloneResponses(responses)),
			resolveNumericShortcut: resolveNumericOptionShortcut,
			applyTemplate,
			accentColor: (text) => theme.fg("accent", text),
			successColor: (text) => theme.fg("success", text),
			warningColor: (text) => theme.fg("warning", text),
			mutedColor: (text) => theme.fg("muted", text),
			dimColor: (text) => theme.fg("dim", text),
			boldText: (text) => theme.bold(text),
		});
	});
}
