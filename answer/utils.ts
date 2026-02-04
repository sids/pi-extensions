export interface ExtractedQuestion {
	question: string;
	context?: string;
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
      "question": "The question text",
      "context": "Optional context that helps answer the question"
    }
  ]
}

Rules:
- Extract all questions that require user input
- Keep questions in the order they appeared
- Be concise with question text
- Include context only when it provides essential information for answering
- If no questions are found, return {"questions": []}

Example output:
{
  "questions": [
    {
      "question": "What is your preferred database?",
      "context": "We can only configure MySQL and PostgreSQL because of what is implemented."
    },
    {
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

/**
 * Parse the JSON response from the LLM.
 */
export function parseExtractionResult(text: string): ExtractionResult | null {
	try {
		// Try to find JSON in the response (it might be wrapped in markdown code blocks)
		let jsonStr = text;

		// Remove markdown code block if present
		const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
		if (jsonMatch) {
			jsonStr = jsonMatch[1].trim();
		}

		const parsed = JSON.parse(jsonStr);
		if (parsed && Array.isArray(parsed.questions)) {
			return parsed as ExtractionResult;
		}
		return null;
	} catch {
		return null;
	}
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
		return (
			question.question === other.question &&
			(question.context ?? "") === (other.context ?? "")
		);
	});
}
