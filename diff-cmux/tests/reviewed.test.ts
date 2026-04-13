import { describe, expect, test } from "bun:test";
import { buildViewedFingerprintsByFileId, getInvalidatedReviewedFileIds, getNextReviewedToggleState, reconcileReviewedByFileId } from "../web/reviewed";

describe("getNextReviewedToggleState", () => {
	test("collapses files when marking them reviewed", () => {
		expect(getNextReviewedToggleState(false)).toEqual({
			reviewed: true,
			collapsed: true,
		});
	});

	test("expands files when marking them unreviewed", () => {
		expect(getNextReviewedToggleState(true)).toEqual({
			reviewed: false,
			collapsed: false,
		});
	});
});

describe("viewed state reconciliation", () => {
	const files = [
		{
			id: "file-a",
			path: "src/a.ts",
			oldPath: null,
			newPath: "src/a.ts",
			status: "modified" as const,
			anchorId: "diff-file-a",
			isBinary: false,
			fingerprint: "fingerprint-a",
		},
		{
			id: "file-b",
			path: "src/b.ts",
			oldPath: null,
			newPath: "src/b.ts",
			status: "modified" as const,
			anchorId: "diff-file-b",
			isBinary: false,
			fingerprint: "fingerprint-b",
		},
	];

	const viewedFingerprintsByFileId = buildViewedFingerprintsByFileId(files);

	test("keeps viewed files when the fingerprint matches", () => {
		expect(reconcileReviewedByFileId({ "file-a": true }, viewedFingerprintsByFileId, files)).toEqual({
			"file-a": true,
		});
	});

	test("clears viewed files when the fingerprint changes", () => {
		expect(reconcileReviewedByFileId({ "file-a": true }, { "file-a": "old-fingerprint" }, files)).toEqual({});
		expect(getInvalidatedReviewedFileIds({ "file-a": true }, { "file-a": "old-fingerprint" }, files)).toEqual(["file-a"]);
	});
});
