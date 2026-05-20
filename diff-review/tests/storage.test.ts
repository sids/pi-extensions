import { afterEach, describe, expect, test, vi } from "vitest";
import { createDefaultStoredReviewState, saveReviewState } from "../web/storage";

describe("createDefaultStoredReviewState", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	test("enables wrapped lines by default", () => {
		expect(createDefaultStoredReviewState().wrapLines).toBe(true);
	});

	test("ignores localStorage write failures", () => {
		vi.stubGlobal("localStorage", {
			setItem: () => {
				throw new Error("quota exceeded");
			},
		});

		expect(() => saveReviewState("review-token", createDefaultStoredReviewState())).not.toThrow();
	});
});
