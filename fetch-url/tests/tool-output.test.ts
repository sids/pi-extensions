import { describe, expect, test } from "bun:test";
import {
	formatFetchUrlTruncationNotice,
	formatFetchUrlTruncationWarning,
	splitFetchUrlPreview,
} from "../tool-output";

describe("splitFetchUrlPreview", () => {
	test("returns the first ten lines and the remaining count", () => {
		const text = Array.from({ length: 12 }, (_value, index) => `Line ${index + 1}`).join("\n");

		const preview = splitFetchUrlPreview(text);

		expect(preview.previewLines).toHaveLength(10);
		expect(preview.previewLines[0]).toBe("Line 1");
		expect(preview.previewLines[9]).toBe("Line 10");
		expect(preview.remainingLines).toBe(2);
	});

	test("handles empty text", () => {
		expect(splitFetchUrlPreview("")).toEqual({
			previewLines: [],
			remainingLines: 0,
		});
	});
});

describe("fetch-url truncation messages", () => {
	const truncation = {
		outputLines: 25,
		totalLines: 100,
		outputBytes: 1024,
		totalBytes: 2048,
	};

	test("formats the context notice", () => {
		expect(formatFetchUrlTruncationNotice(truncation, "/tmp/fetch-url.txt")).toBe(
			"[Output truncated: 25 of 100 lines (1.0KB of 2.0KB). Full output saved to: /tmp/fetch-url.txt]",
		);
	});

	test("formats the UI warning", () => {
		expect(formatFetchUrlTruncationWarning(truncation, "/tmp/fetch-url.txt")).toBe(
			"Output truncated (25/100 lines, 1.0KB of 2.0KB). Full output: /tmp/fetch-url.txt",
		);
	});
});
