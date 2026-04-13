import { describe, expect, test } from "bun:test";
import { createDefaultStoredViewerState } from "../web/storage";

describe("createDefaultStoredViewerState", () => {
	test("enables wrapped lines by default", () => {
		expect(createDefaultStoredViewerState().wrapLines).toBeTrue();
	});
});
