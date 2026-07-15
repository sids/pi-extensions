import { completeSimple, type Api, type AssistantMessage, type Model, type UserMessage } from "@earendil-works/pi-ai/compat";
import {
	buildSessionContext,
	convertToLlm,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";

const FALLBACK_SYSTEM_PROMPT = "You are a helpful coding assistant.";
export const SIDE_SUMMARY_MAX_TOKENS = 1_400;

export interface ParentSessionSnapshot {
	sessionId: string;
	sessionFile?: string;
	leafId?: string;
	entries: SessionEntry[];
	entryIds: Set<string>;
	model: Model<Api>;
	systemPrompt: string;
	thinkingLevel: string;
}

type SummaryDependencies = {
	complete?: typeof completeSimple;
	now?: () => number;
	signal?: AbortSignal;
};

export function captureParentSessionSnapshot(
	ctx: ExtensionContext,
	thinkingLevel: string,
): ParentSessionSnapshot {
	const entries = ctx.sessionManager.getEntries() as SessionEntry[];
	return {
		sessionId: ctx.sessionManager.getSessionId(),
		sessionFile: ctx.sessionManager.getSessionFile(),
		leafId: ctx.sessionManager.getLeafId() ?? undefined,
		entries: [...entries],
		entryIds: new Set(entries.map((entry) => entry.id)),
		model: ctx.model as Model<Api>,
		systemPrompt: ctx.getSystemPrompt(),
		thinkingLevel,
	};
}

export function buildSideSummaryPrompt(): string {
	return [
		"Summarize this conversation as context for a separate, ephemeral side chat.",
		"The side chat will answer follow-up questions without continuing the main task.",
		"Write a concise, neutral handoff covering the goal and background, important decisions and constraints, relevant files or symbols, completed work, current activity at this snapshot, and unresolved questions.",
		"Do not review the work, recommend changes, or invent details. Prefer specific facts that will help answer later questions.",
		"Keep the summary useful but below 800 words.",
		"",
		"Output only a JSON object with this structure:",
		'{ "summary": "Markdown summary without a title heading" }',
		"Do not wrap the JSON in markdown fences or include text outside the object.",
	].join("\n");
}

export function extractSummaryAssistantText(message: AssistantMessage): string {
	return message.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map((content) => content.text)
		.join("\n")
		.trim();
}

export function parseSideSummaryResult(text: string): string | null {
	try {
		let json = text.trim();
		const fenced = json.match(/```(?:json)?\s*([\s\S]*?)```/i);
		if (fenced) {
			json = fenced[1].trim();
		}
		const parsed = JSON.parse(json) as { summary?: unknown };
		if (typeof parsed.summary !== "string") {
			return null;
		}
		const summary = parsed.summary
			.trim()
			.replace(/^#{1,6}\s+(?:conversation\s+|side(?:-chat)?\s+)?summary\b[^\n]*\n+/i, "")
			.trim();
		return summary || null;
	} catch {
		return null;
	}
}

async function getModelAuth(ctx: ExtensionContext, model: Model<Api>) {
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		throw new Error(auth.error);
	}
	return auth;
}

export async function summarizeParentSnapshot(
	ctx: ExtensionContext,
	snapshot: ParentSessionSnapshot,
	dependencies: SummaryDependencies = {},
): Promise<string | null> {
	if (!snapshot.model || snapshot.entries.length === 0) {
		return null;
	}
	if (snapshot.leafId && !snapshot.entries.some((entry) => entry.id === snapshot.leafId)) {
		return null;
	}

	const byId = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
	const context = buildSessionContext(snapshot.entries, snapshot.leafId ?? null, byId);
	const messages = convertToLlm(context.messages);
	if (messages.length === 0) {
		return null;
	}

	const auth = await getModelAuth(ctx, snapshot.model);
	const prompt: UserMessage = {
		role: "user",
		content: [{ type: "text", text: buildSideSummaryPrompt() }],
		timestamp: dependencies.now?.() ?? Date.now(),
	};
	const response = await (dependencies.complete ?? completeSimple)(
		snapshot.model,
		{
			systemPrompt: snapshot.systemPrompt.trim() || FALLBACK_SYSTEM_PROMPT,
			messages: [...messages, prompt],
		},
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			env: auth.env,
			maxTokens: SIDE_SUMMARY_MAX_TOKENS,
			sessionId: snapshot.sessionId,
			signal: dependencies.signal,
		},
	);
	if (response.stopReason === "error" || response.stopReason === "aborted") {
		throw new Error(response.errorMessage ?? `Summary completion ${response.stopReason}`);
	}
	return parseSideSummaryResult(extractSummaryAssistantText(response));
}
