import { describe, expect, test } from "vitest";
import { isProjectTrusted } from "../project-trust";

describe("isProjectTrusted", () => {
	test("uses the context trust decision when available", () => {
		expect(isProjectTrusted({ isProjectTrusted: () => true })).toBe(true);
		expect(isProjectTrusted({ isProjectTrusted: () => false })).toBe(false);
	});

	test("defaults to trusted for legacy test contexts", () => {
		expect(isProjectTrusted({})).toBe(true);
	});
});
