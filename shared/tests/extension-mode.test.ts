import { describe, expect, test } from "vitest";
import { isTuiMode } from "../extension-mode";

describe("isTuiMode", () => {
	test("uses ctx.mode when available", () => {
		expect(isTuiMode({ mode: "tui", hasUI: true })).toBe(true);
		expect(isTuiMode({ mode: "rpc", hasUI: true })).toBe(false);
		expect(isTuiMode({ mode: "json", hasUI: false })).toBe(false);
		expect(isTuiMode({ mode: "print", hasUI: false })).toBe(false);
	});

	test("falls back to hasUI for legacy test contexts", () => {
		expect(isTuiMode({ hasUI: true })).toBe(true);
		expect(isTuiMode({ hasUI: false })).toBe(false);
	});

	test("defaults to TUI for minimal legacy contexts", () => {
		expect(isTuiMode({})).toBe(true);
	});
});
