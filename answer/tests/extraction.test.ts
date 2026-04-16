import { describe, expect, test } from "bun:test";
import type { AssistantMessage, Api, Model } from "@mariozechner/pi-ai";
import {
	EXTRACTION_CANCELLED,
	classifyExtractionResponse,
	selectExtractionModel,
} from "../index";
import { parseExtractionResult } from "../utils";

/**
 * Builds a minimal AssistantMessage. Only the fields exercised by
 * `classifyExtractionResponse` are meaningful; the rest satisfy the type.
 */
function makeAssistantMessage(
	overrides: Partial<AssistantMessage> & Pick<AssistantMessage, "stopReason">,
): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-haiku-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 0,
		...overrides,
	} as AssistantMessage;
}

/**
 * Builds a minimal Model fixture; `selectExtractionModel` only reads `provider`
 * and `id` for matching, so the other fields are stub values.
 */
function makeModel(provider: string, id: string): Model<Api> {
	return {
		id,
		name: id,
		provider,
		api: "anthropic-messages",
		baseUrl: "https://example.invalid",
		input: ["text"],
		reasoning: false,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 1000,
	} as unknown as Model<Api>;
}

describe("classifyExtractionResponse", () => {
	test("returns CANCELLED sentinel when the response was aborted", () => {
		const result = classifyExtractionResponse(makeAssistantMessage({ stopReason: "aborted" }));
		expect(result).toBe(EXTRACTION_CANCELLED);
	});

	test("returns Error with provider message when stopReason is error", () => {
		const result = classifyExtractionResponse(
			makeAssistantMessage({ stopReason: "error", errorMessage: "rate limited" }),
		);
		expect(result).toBeInstanceOf(Error);
		expect((result as Error).message).toContain("rate limited");
	});

	test("returns Error with 'unknown error' when stopReason is error and no message", () => {
		const result = classifyExtractionResponse(makeAssistantMessage({ stopReason: "error" }));
		expect(result).toBeInstanceOf(Error);
		expect((result as Error).message).toContain("unknown error");
	});

	// Bug #2 regression: reasoning models can return only `thinking` blocks
	// when `thinkingEnabled` was not explicitly disabled. The text-block filter
	// then collapses to empty string, parseExtractionResult returns null, and
	// previously the user just saw a silent "Cancelled". Now it must surface as
	// an Error.
	test("returns Error (not CANCELLED) for thinking-only responses with no text", () => {
		const response = makeAssistantMessage({
			stopReason: "stop",
			content: [
				// Anthropic thinking block (no `text` field)
				{ type: "thinking", thinking: "deliberating...", thinkingSignature: "sig" },
			],
		} as unknown as Partial<AssistantMessage> & { stopReason: "stop" });

		const result = classifyExtractionResponse(response);
		expect(result).toBeInstanceOf(Error);
		expect((result as Error).message).toContain("Could not parse questions");
		// Empty raw response is still surfaced (truncation fits 500 chars).
		expect((result as Error).message).toContain("Raw response:");
	});

	test("returns Error and includes a snippet of the raw response when JSON cannot be parsed", () => {
		const garbage = "x".repeat(800);
		const response = makeAssistantMessage({
			stopReason: "stop",
			content: [{ type: "text", text: garbage }],
		});

		const result = classifyExtractionResponse(response);
		expect(result).toBeInstanceOf(Error);
		const message = (result as Error).message;
		expect(message).toContain("Could not parse questions");
		// Snippet is bounded to 500 chars (per index.ts).
		expect(message).toContain("x".repeat(500));
		expect(message).not.toContain("x".repeat(501));
	});

	test("returns parsed ExtractionResult for a well-formed JSON response", () => {
		const response = makeAssistantMessage({
			stopReason: "stop",
			content: [
				{
					type: "text",
					text: JSON.stringify({ questions: [{ question: "Ship now?" }] }),
				},
			],
		});

		const result = classifyExtractionResponse(response);
		expect(result).not.toBe(EXTRACTION_CANCELLED);
		expect(result).not.toBeInstanceOf(Error);
		// Type narrowing: it must be the ExtractionResult shape.
		const parsed = result as { questions: { id: string; question: string }[] };
		expect(parsed.questions).toHaveLength(1);
		expect(parsed.questions[0].question).toBe("Ship now?");
		expect(parsed.questions[0].id).toBe("ship_now");
	});

	test("concatenates multiple text blocks (joined by newline) before parsing", () => {
		// Real-world shape: providers may emit a fenced JSON block as separate
		// text segments split on newlines. classifyExtractionResponse joins with
		// "\n" and parseExtractionResult unwraps the fence.
		const response = makeAssistantMessage({
			stopReason: "stop",
			content: [
				{ type: "text", text: "```json" },
				{ type: "text", text: JSON.stringify({ questions: [{ question: "Multi block?" }] }) },
				{ type: "text", text: "```" },
			],
		});

		const result = classifyExtractionResponse(response);
		expect(result).not.toBeInstanceOf(Error);
		const parsed = result as { questions: { question: string }[] };
		expect(parsed.questions[0].question).toBe("Multi block?");
	});
});

describe("parseExtractionResult (regression)", () => {
	// Locks in the upstream contract that classifyExtractionResponse depends on:
	// empty/whitespace-only text must yield null so the caller can produce an
	// actionable error message instead of treating it as success.
	test("returns null for empty string", () => {
		expect(parseExtractionResult("")).toBeNull();
	});

	test("returns null for whitespace only", () => {
		expect(parseExtractionResult("   \n\t  ")).toBeNull();
	});
});

describe("selectExtractionModel", () => {
	function makeRegistry(opts: {
		models: Model<Api>[];
		// Per-model auth response keyed by `${provider}:${id}`
		auth: Record<string, { ok: boolean; apiKey?: string; headers?: Record<string, string> }>;
		recordCalls?: string[];
	}) {
		return {
			find(provider: string, id: string) {
				return opts.models.find((m) => m.provider === provider && m.id === id);
			},
			async getApiKeyAndHeaders(model: Model<Api>) {
				opts.recordCalls?.push(`${model.provider}:${model.id}`);
				return opts.auth[`${model.provider}:${model.id}`] ?? { ok: false };
			},
		};
	}

	const fallback = makeModel("anthropic", "claude-sonnet-current");

	test("returns the first preference whose provider has both ok and apiKey", async () => {
		const codex = makeModel("openai-codex", "gpt-5.1-codex-mini");
		const haiku = makeModel("anthropic", "claude-haiku-4-5");
		const registry = makeRegistry({
			models: [codex, haiku],
			auth: {
				"openai-codex:gpt-5.1-codex-mini": { ok: true, apiKey: "key-codex" },
				"anthropic:claude-haiku-4-5": { ok: true, apiKey: "key-haiku" },
			},
		});

		const selected = await selectExtractionModel(fallback, registry, [
			{ provider: "openai-codex", id: "gpt-5.1-codex-mini" },
			{ provider: "anthropic", id: "claude-haiku-4-5" },
		]);

		expect(selected).toBe(codex);
	});

	// Bug #1 regression: keyless providers (openai-codex via OAuth) return
	// { ok: true } with no apiKey. The old guard accepted them, which silently
	// fell back to environment-variable lookup inside complete(). The fix skips
	// such entries and continues to the next preference.
	test("skips preferences that are ok but have no apiKey (keyless provider)", async () => {
		const codex = makeModel("openai-codex", "gpt-5.1-codex-mini");
		const haiku = makeModel("anthropic", "claude-haiku-4-5");
		const registry = makeRegistry({
			models: [codex, haiku],
			auth: {
				"openai-codex:gpt-5.1-codex-mini": { ok: true }, // keyless
				"anthropic:claude-haiku-4-5": { ok: true, apiKey: "key-haiku" },
			},
		});

		const selected = await selectExtractionModel(fallback, registry, [
			{ provider: "openai-codex", id: "gpt-5.1-codex-mini" },
			{ provider: "anthropic", id: "claude-haiku-4-5" },
		]);

		expect(selected).toBe(haiku);
	});

	test("skips preferences whose model the registry cannot find", async () => {
		const haiku = makeModel("anthropic", "claude-haiku-4-5");
		const calls: string[] = [];
		const registry = makeRegistry({
			models: [haiku],
			auth: { "anthropic:claude-haiku-4-5": { ok: true, apiKey: "key-haiku" } },
			recordCalls: calls,
		});

		const selected = await selectExtractionModel(fallback, registry, [
			{ provider: "openai-codex", id: "missing-model" },
			{ provider: "anthropic", id: "claude-haiku-4-5" },
		]);

		expect(selected).toBe(haiku);
		// getApiKeyAndHeaders must not be invoked for an unfound preference.
		expect(calls).toEqual(["anthropic:claude-haiku-4-5"]);
	});

	test("skips preferences whose auth is not ok", async () => {
		const codex = makeModel("openai-codex", "gpt-5.1-codex-mini");
		const haiku = makeModel("anthropic", "claude-haiku-4-5");
		const registry = makeRegistry({
			models: [codex, haiku],
			auth: {
				"openai-codex:gpt-5.1-codex-mini": { ok: false },
				"anthropic:claude-haiku-4-5": { ok: true, apiKey: "key-haiku" },
			},
		});

		const selected = await selectExtractionModel(fallback, registry, [
			{ provider: "openai-codex", id: "gpt-5.1-codex-mini" },
			{ provider: "anthropic", id: "claude-haiku-4-5" },
		]);

		expect(selected).toBe(haiku);
	});

	test("falls back to the current model when no preference is usable", async () => {
		const codex = makeModel("openai-codex", "gpt-5.1-codex-mini");
		const registry = makeRegistry({
			models: [codex],
			auth: { "openai-codex:gpt-5.1-codex-mini": { ok: true } }, // keyless only
		});

		const selected = await selectExtractionModel(fallback, registry, [
			{ provider: "openai-codex", id: "gpt-5.1-codex-mini" },
		]);

		expect(selected).toBe(fallback);
	});

	test("falls back to the current model when the preference list is empty", async () => {
		const registry = makeRegistry({ models: [], auth: {} });
		const selected = await selectExtractionModel(fallback, registry, []);
		expect(selected).toBe(fallback);
	});
});
