import { describe, expect, test } from "bun:test";
import {
	DEFAULT_MULTI_QUERY_COUNT,
	DEFAULT_SINGLE_QUERY_COUNT,
	MAX_COUNT,
	buildErrorPayload,
	parseErrorPayload,
	resolveCount,
	resolveQueries,
} from "../utils";

describe("resolveQueries", () => {
	test("prefers trimmed query and queries", () => {
		const result = resolveQueries({
			query: "  brave search  ",
			queries: ["  pi extensions ", "", " web search"],
		});

		expect(result).toEqual(["brave search", "pi extensions", "web search"]);
	});

	test("returns empty array when no input", () => {
		expect(resolveQueries({})).toEqual([]);
	});
});

describe("resolveCount", () => {
	test("defaults for single and multi queries", () => {
		expect(resolveCount({}, 1)).toBe(DEFAULT_SINGLE_QUERY_COUNT);
		expect(resolveCount({}, 2)).toBe(DEFAULT_MULTI_QUERY_COUNT);
	});

	test("clamps to max and min", () => {
		expect(resolveCount({ count: MAX_COUNT + 5 }, 1)).toBe(MAX_COUNT);
		expect(resolveCount({ count: 0 }, 1)).toBe(1);
	});
});

describe("error payload", () => {
	test("round-trips build/parse", () => {
		const payload = buildErrorPayload(["one", "two"], "Rate limited");
		expect(parseErrorPayload(payload)).toEqual({
			queries: ["one", "two"],
			message: "Rate limited",
		});
	});

	test("returns null for non-payload", () => {
		expect(parseErrorPayload("not a payload")).toBeNull();
	});
});
