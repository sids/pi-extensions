export interface ExtractedQuestionOption {
	label: string;
	description: string;
}

export interface ExtractedQuestion {
	id?: string;
	header?: string;
	question: string;
	context?: string;
	options?: ExtractedQuestionOption[];
}

export interface ExtractionResult {
	questions: ExtractedQuestion[];
}

export interface ModelPreference {
	provider: string;
	id: string;
}

export type AnswerTemplateConfig = string | { label?: string; template: string };

export interface AnswerTemplate {
	label: string;
	template: string;
}

export interface AnswerDraftSettings {
	enabled?: boolean;
	autosaveMs?: number;
	promptOnRestore?: boolean;
}

export interface AnswerSettings {
	systemPrompt?: string;
	extractionModels?: ModelPreference[];
	answerTemplates?: AnswerTemplateConfig[];
	drafts?: AnswerDraftSettings;
}

export const DEFAULT_SYSTEM_PROMPT = `You are a question extractor. Given text from a conversation, extract any questions that need answering.

Output a JSON object with this structure:
{
  "questions": [
    {
      "id": "preferred_database",
      "header": "Database",
      "question": "What is your preferred database?",
      "context": "Optional context that helps answer the question",
      "options": [
        {
          "label": "PostgreSQL",
          "description": "Mature relational option with strong ecosystem"
        }
      ]
    }
  ]
}

Rules:
- Extract all questions that require user input
- Keep questions in the order they appeared
- Keep id values stable snake_case when possible
- Keep header concise when provided
- Header is optional; omit it when the question alone is clear
- Include context only when it provides essential information for answering
- Include options only when the text clearly suggests concrete choices
- Each option needs a short label and one-sentence description
- Option labels should fully represent the answer to the question on their own
- If no questions are found, return {"questions": []}

Example output:
{
  "questions": [
    {
      "id": "database_choice",
      "header": "Database",
      "question": "What is your preferred database?",
      "context": "We can only configure MySQL and PostgreSQL because of what is implemented.",
      "options": [
        {
          "label": "PostgreSQL",
          "description": "Best fit for complex queries and strong defaults."
        },
        {
          "label": "MySQL",
          "description": "Good compatibility with common hosting environments."
        }
      ]
    },
    {
      "id": "language_choice",
      "header": "Language",
      "question": "Should we use TypeScript or JavaScript?"
    }
  ]
}`;

export const DEFAULT_MODEL_PREFERENCES: ModelPreference[] = [
	{ provider: "openai-codex", id: "gpt-5.1-codex-mini" },
	{ provider: "anthropic", id: "claude-haiku-4-5" },
];

export const DEFAULT_DRAFT_SETTINGS: Required<AnswerDraftSettings> = {
	enabled: true,
	autosaveMs: 1000,
	promptOnRestore: true,
};

export function mergeAnswerSettings(
	globalSettings: AnswerSettings | undefined,
	projectSettings: AnswerSettings | undefined,
): AnswerSettings {
	return {
		systemPrompt: projectSettings?.systemPrompt ?? globalSettings?.systemPrompt,
		extractionModels: projectSettings?.extractionModels ?? globalSettings?.extractionModels,
		answerTemplates: projectSettings?.answerTemplates ?? globalSettings?.answerTemplates,
		drafts: {
			enabled:
				projectSettings?.drafts?.enabled ??
				globalSettings?.drafts?.enabled ??
				DEFAULT_DRAFT_SETTINGS.enabled,
			autosaveMs:
				projectSettings?.drafts?.autosaveMs ??
				globalSettings?.drafts?.autosaveMs ??
				DEFAULT_DRAFT_SETTINGS.autosaveMs,
			promptOnRestore:
				projectSettings?.drafts?.promptOnRestore ??
				globalSettings?.drafts?.promptOnRestore ??
				DEFAULT_DRAFT_SETTINGS.promptOnRestore,
		},
	};
}

export function normalizeTemplates(templates?: AnswerTemplateConfig[]): AnswerTemplate[] {
	if (!templates || templates.length === 0) {
		return [];
	}

	return templates
		.map((template, index) => {
			if (typeof template === "string") {
				return {
					label: `Template ${index + 1}`,
					template,
				};
			}

			return {
				label: template.label?.trim() || `Template ${index + 1}`,
				template: template.template,
			};
		})
		.filter((template) => template.template.trim().length > 0);
}

export function applyTemplate(
	template: string,
	data: {
		question: string;
		context?: string;
		answer: string;
		index: number;
		total: number;
	},
): string {
	const replacements: Record<string, string> = {
		question: data.question,
		context: data.context ?? "",
		answer: data.answer,
		index: String(data.index + 1),
		total: String(data.total),
	};

	return template.replace(/\{\{(question|context|answer|index|total)\}\}/g, (_match, key: string) => {
		return replacements[key] ?? "";
	});
}

export function resolveNumericOptionShortcut(
	input: string,
	maxOptionIndex: number,
	usingCustomEditor: boolean,
): number | null {
	if (usingCustomEditor) {
		return null;
	}

	if (!/^[1-9]$/.test(input)) {
		return null;
	}

	const selectedIndex = Number(input) - 1;
	if (selectedIndex > maxOptionIndex) {
		return null;
	}

	return selectedIndex;
}

function normalizeIdentifier(raw: string | undefined, fallback: string, usedIds: Set<string>): string {
	const base = (raw ?? fallback)
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_+|_+$/g, "");

	let id = base || "question";
	let suffix = 2;
	while (usedIds.has(id)) {
		id = `${base || "question"}_${suffix}`;
		suffix += 1;
	}

	usedIds.add(id);
	return id;
}

function normalizeHeader(raw: string | undefined): string | undefined {
	const preferred = raw?.trim();
	if (preferred && preferred.length > 0) {
		return preferred;
	}

	return undefined;
}

function normalizeOptions(raw: unknown): ExtractedQuestionOption[] {
	if (!Array.isArray(raw)) {
		return [];
	}

	return raw
		.map((option): ExtractedQuestionOption | null => {
			if (!option || typeof option !== "object") {
				return null;
			}

			const value = option as { label?: unknown; description?: unknown };
			if (typeof value.label !== "string") {
				return null;
			}

			const label = value.label.trim();
			if (label.length === 0) {
				return null;
			}

			return {
				label,
				description: typeof value.description === "string" ? value.description.trim() : "",
			};
		})
		.filter((option): option is ExtractedQuestionOption => option !== null);
}

function normalizeQuestions(rawQuestions: unknown[]): ExtractedQuestion[] {
	const usedIds = new Set<string>();
	const questions: ExtractedQuestion[] = [];

	for (const rawQuestion of rawQuestions) {
		if (!rawQuestion || typeof rawQuestion !== "object") {
			continue;
		}

		const value = rawQuestion as {
			id?: unknown;
			header?: unknown;
			question?: unknown;
			context?: unknown;
			options?: unknown;
		};

		if (typeof value.question !== "string") {
			continue;
		}

		const question = value.question.trim();
		if (question.length === 0) {
			continue;
		}

		const id = normalizeIdentifier(typeof value.id === "string" ? value.id : undefined, question, usedIds);
		const header = normalizeHeader(typeof value.header === "string" ? value.header : undefined);
		const context = typeof value.context === "string" ? value.context.trim() : "";
		const options = normalizeOptions(value.options);

		questions.push({
			id,
			...(header ? { header } : {}),
			question,
			...(context.length > 0 ? { context } : {}),
			...(options.length > 0 ? { options } : {}),
		});
	}

	return questions;
}

/**
 * Parse the JSON response from the LLM.
 */
export function parseExtractionResult(text: string): ExtractionResult | null {
	try {
		let jsonStr = text;

		const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
		if (jsonMatch) {
			jsonStr = jsonMatch[1].trim();
		}

		const parsed = JSON.parse(jsonStr) as { questions?: unknown };
		if (!parsed || !Array.isArray(parsed.questions)) {
			return null;
		}

		return {
			questions: normalizeQuestions(parsed.questions),
		};
	} catch {
		return null;
	}
}

function normalizeComparableText(text: string | undefined): string {
	return (text ?? "")
		.toLowerCase()
		.replace(/\s+/g, " ")
		.trim();
}

function questionsReferToSamePrompt(left: ExtractedQuestion, right: ExtractedQuestion): boolean {
	const leftId = normalizeComparableText(left.id);
	const rightId = normalizeComparableText(right.id);
	if (leftId.length > 0 && rightId.length > 0 && leftId === rightId) {
		return true;
	}

	const leftQuestion = normalizeComparableText(left.question);
	const rightQuestion = normalizeComparableText(right.question);
	return leftQuestion.length > 0 && leftQuestion === rightQuestion;
}

export function questionsMatch(
	left: ExtractedQuestion[] | undefined,
	right: ExtractedQuestion[] | undefined,
): boolean {
	if (!left || !right || left.length !== right.length) {
		return false;
	}

	return left.every((question, index) => {
		const other = right[index];
		if (!questionsReferToSamePrompt(question, other)) {
			return false;
		}

		const leftOptions = question.options ?? [];
		const rightOptions = other.options ?? [];
		if (leftOptions.length !== rightOptions.length) {
			return false;
		}

		return leftOptions.every((option, optionIndex) => {
			const otherOption = rightOptions[optionIndex];
			return normalizeComparableText(option.label) === normalizeComparableText(otherOption.label);
		});
	});
}
