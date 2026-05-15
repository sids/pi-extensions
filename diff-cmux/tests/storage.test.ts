import { describe, expect, test } from "vitest";
import { createDefaultStoredViewerState } from "../web/storage";

describe("createDefaultStoredViewerState", () => {
	test("enables wrapped lines by default", () => {
		expect(createDefaultStoredViewerState().wrapLines).toBe(true);
	});
});
