import { describe, expect, test } from "vitest";
import { createDefaultStoredReviewState } from "../web/storage";

describe("createDefaultStoredReviewState", () => {
	test("enables wrapped lines by default", () => {
		expect(createDefaultStoredReviewState().wrapLines).toBe(true);
	});
});
