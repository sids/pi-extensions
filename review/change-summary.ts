import { completeSimple, type Api, type AssistantMessage, type Model, type UserMessage } from "@mariozechner/pi-ai";
import {
	buildSessionContext,
	convertToLlm,
	type ExtensionContext,
	type SessionEntry,
} from "@mariozechner/pi-coding-agent";

const FALLBACK_SYSTEM_PROMPT = "You are a helpful coding assistant.";

export type ModelAuth = {
	apiKey?: string;
	headers?: Record<string, string>;
};

type SummarizeDependencies = {
	complete?: typeof completeSimple;
	now?: () => number;
};

export function buildSessionChangeSummaryPrompt(): string {
	return [
		"Summarize the changes made so far in this conversation for a code review handoff.",
		"",
		"Write a concise, neutral markdown summary. This is not a code review: do not list bugs, risks, approvals, or recommendations.",
		"Focus on the likely goal, motivation, context, and expected outcome for the change.",
		"Write 2-3 short paragraphs or bullets at most.",
		"Do not produce a changelog, file-by-file walkthrough, implementation checklist, or test summary.",
		"Avoid naming files, functions, tests, package metadata, or implementation mechanisms unless they are essential to understanding the goal.",
		"Keep it under 100 words.",
		"",
		"Output only a JSON object with this structure:",
		'{ "summary": "Markdown summary text without a title heading" }',
		"Do not wrap the JSON in markdown fences. Do not include any text outside the JSON object.",
	].join("\n");
}

export function extractAssistantText(message: AssistantMessage): string {
	return message.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map((content) => content.text)
		.join("\n")
		.trim();
}

export function parseChangeSummaryResult(text: string): string | null {
	try {
		let jsonStr = text.trim();
		const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
		if (jsonMatch) {
			jsonStr = jsonMatch[1].trim();
		}

		const parsed = JSON.parse(jsonStr) as { summary?: unknown };
		if (!parsed || typeof parsed.summary !== "string") {
			return null;
		}

		const summary = parsed.summary.trim();
		return summary.length > 0 ? summary : null;
	} catch {
		return null;
	}
}

export function formatChangeSummary(summary: string): string {
	const trimmed = summary.trim();
	if (/^#\s+Summary of changes\s*$/im.test(trimmed.split("\n", 1)[0] ?? "")) {
		return trimmed;
	}

	const withoutGeneratedHeading = trimmed.replace(/^#{1,6}\s+(?:change\s+)?summary\b[^\n]*\n+/i, "").trim();
	return `# Summary of changes\n\n${withoutGeneratedHeading}`;
}

async function getModelAuth(ctx: ExtensionContext, model: Model<Api>): Promise<ModelAuth> {
	const registry = ctx.modelRegistry as unknown as {
		getApiKeyAndHeaders?: (model: Model<Api>) => Promise<{
			ok: boolean;
			apiKey?: string;
			headers?: Record<string, string>;
			error?: string;
		}>;
		getApiKey?: (model: Model<Api>) => Promise<string | undefined>;
	};

	if (registry.getApiKeyAndHeaders) {
		const auth = await registry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			throw new Error(auth.error ?? `No API key available for ${model.provider}/${model.id}`);
		}
		return { apiKey: auth.apiKey, headers: auth.headers };
	}

	const apiKey = await registry.getApiKey?.(model);
	if (!apiKey) {
		throw new Error(`No API key available for ${model.provider}/${model.id}`);
	}
	return { apiKey };
}

function buildSourceBranchMessages(ctx: ExtensionContext, sourceLeafId: string | undefined) {
	if (sourceLeafId && !ctx.sessionManager.getEntry(sourceLeafId)) {
		return [];
	}

	const entries = ctx.sessionManager.getEntries() as SessionEntry[];
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const sessionContext = buildSessionContext(entries, sourceLeafId ?? ctx.sessionManager.getLeafId(), byId);
	return convertToLlm(sessionContext.messages);
}

export async function summarizeChangesFromSessionHistory(
	ctx: ExtensionContext,
	sourceLeafId: string | undefined,
	dependencies: SummarizeDependencies = {},
): Promise<string | null> {
	const model = ctx.model as Model<Api> | undefined;
	if (!model) {
		return null;
	}

	const messages = buildSourceBranchMessages(ctx, sourceLeafId);
	if (messages.length === 0) {
		return null;
	}

	const auth = await getModelAuth(ctx, model);
	const userMessage: UserMessage = {
		role: "user",
		content: [{ type: "text", text: buildSessionChangeSummaryPrompt() }],
		timestamp: dependencies.now?.() ?? Date.now(),
	};
	const completion = await (dependencies.complete ?? completeSimple)(
		model,
		{ systemPrompt: ctx.getSystemPrompt().trim() || FALLBACK_SYSTEM_PROMPT, messages: [...messages, userMessage] },
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			maxTokens: 1_000,
			sessionId: ctx.sessionManager.getSessionId(),
		},
	);
	if (completion.stopReason === "error" || completion.stopReason === "aborted") {
		throw new Error(completion.errorMessage ?? `Summary completion ${completion.stopReason}`);
	}

	const summary = parseChangeSummaryResult(extractAssistantText(completion));
	return summary ? formatChangeSummary(summary) : null;
}
