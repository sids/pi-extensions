import { contentText } from "@earendil-works/pi-ai";
import { type Api, type AssistantMessage, type Model, type UserMessage } from "@earendil-works/pi-ai/compat";
import {
	buildSessionContext,
	convertToLlm,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";

const FALLBACK_SYSTEM_PROMPT = "You are a helpful coding assistant.";

type SummarizeDependencies = {
	complete?: ExtensionContext["modelRegistry"]["complete"];
	now?: () => number;
	signal?: AbortSignal;
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
	return contentText(message.content).trim();
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

	const userMessage: UserMessage = {
		role: "user",
		content: [{ type: "text", text: buildSessionChangeSummaryPrompt() }],
		timestamp: dependencies.now?.() ?? Date.now(),
	};
	const context = {
		systemPrompt: ctx.getSystemPrompt().trim() || FALLBACK_SYSTEM_PROMPT,
		messages: [...messages, userMessage],
	};
	const options = {
		maxTokens: 1_000,
		sessionId: ctx.sessionManager.getSessionId(),
		signal: dependencies.signal ?? ctx.signal,
	};
	const completion = dependencies.complete
		? await dependencies.complete(model, context, options)
		: await ctx.modelRegistry.complete(model, context, options);
	if (completion.stopReason === "error" || completion.stopReason === "aborted") {
		throw new Error(completion.errorMessage ?? `Summary completion ${completion.stopReason}`);
	}

	const summary = parseChangeSummaryResult(extractAssistantText(completion));
	return summary ? formatChangeSummary(summary) : null;
}
