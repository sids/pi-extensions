import { describe, expect, test } from "vitest";
import {
	formatCacheTtl,
	inspectPromptCacheTtl,
	ONE_DAY_CACHE_TTL_MS,
	ONE_HOUR_CACHE_TTL_MS,
	SHORT_CACHE_TTL_MS,
} from "../utils";

describe("inspectPromptCacheTtl", () => {
	test("returns undefined when the payload has no cache configuration", () => {
		expect(inspectPromptCacheTtl({ model: "claude" })).toBeUndefined();
	});

	test("detects Anthropic short and long cache controls", () => {
		expect(
			inspectPromptCacheTtl({
				system: [{ type: "text", text: "prompt", cache_control: { type: "ephemeral" } }],
			}),
		).toBe(SHORT_CACHE_TTL_MS);
		expect(
			inspectPromptCacheTtl({
				system: [{ type: "text", text: "prompt", cache_control: { type: "ephemeral", ttl: "1h" } }],
			}),
		).toBe(ONE_HOUR_CACHE_TTL_MS);
	});

	test("detects OpenAI short and 24-hour prompt cache retention", () => {
		expect(inspectPromptCacheTtl({ prompt_cache_key: "session-1" })).toBe(SHORT_CACHE_TTL_MS);
		expect(inspectPromptCacheTtl({ prompt_cache_key: "session-1", prompt_cache_retention: "24h" })).toBe(
			ONE_DAY_CACHE_TTL_MS,
		);
	});

	test("detects Bedrock one-hour cache points", () => {
		expect(
			inspectPromptCacheTtl({
				messages: [{ content: [{ cachePoint: { type: "default", ttl: "1h" } }] }],
			}),
		).toBe(ONE_HOUR_CACHE_TTL_MS);
	});

	test("returns null for unknown retention and explicitly disabled caching", () => {
		expect(inspectPromptCacheTtl({ options: { cacheRetention: "long" } })).toBeNull();
		expect(inspectPromptCacheTtl({ cache_control: { type: "ephemeral", ttl: "provider-default" } })).toBeNull();
		expect(inspectPromptCacheTtl({ options: { cacheRetention: "none" } })).toBeNull();
	});

	test("ignores unrelated ttl fields in request content", () => {
		expect(
			inspectPromptCacheTtl({ tools: [{ input_schema: { properties: { ttl: { const: "24h" } } } }] }),
		).toBeUndefined();
		expect(inspectPromptCacheTtl({ messages: [{ cache_control: { ttl: "1h" } }] })).toBeUndefined();
	});
});

describe("formatCacheTtl", () => {
	test("formats short and long cache windows", () => {
		expect(formatCacheTtl(SHORT_CACHE_TTL_MS)).toBe("5 minutes");
		expect(formatCacheTtl(ONE_HOUR_CACHE_TTL_MS)).toBe("1 hour");
		expect(formatCacheTtl(ONE_DAY_CACHE_TTL_MS)).toBe("1 day");
	});
});
