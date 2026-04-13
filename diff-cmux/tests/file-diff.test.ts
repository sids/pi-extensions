import { describe, expect, test } from "bun:test";
import { getFileDetailText } from "../web/components/file-diff";

describe("getFileDetailText", () => {
	test("does not show detail text for newly added files", () => {
		expect(
			getFileDetailText({
				id: "file-1",
				path: "diff-cmux/CHANGELOG.md",
				oldPath: "/dev/null",
				newPath: "diff-cmux/CHANGELOG.md",
				status: "added",
				anchorId: "file-1",
				isBinary: false,
			}),
		).toBeNull();
	});

	test("keeps rename metadata for renamed files", () => {
		expect(
			getFileDetailText({
				id: "file-2",
				path: "src/new-name.ts",
				oldPath: "src/old-name.ts",
				newPath: "src/new-name.ts",
				status: "renamed",
				anchorId: "file-2",
				isBinary: false,
			}),
		).toBe("src/old-name.ts → src/new-name.ts");
	});

	test("does not show detail text for deleted files", () => {
		expect(
			getFileDetailText({
				id: "file-3",
				path: "src/old-name.ts",
				oldPath: "src/old-name.ts",
				newPath: "/dev/null",
				status: "deleted",
				anchorId: "file-3",
				isBinary: false,
			}),
		).toBeNull();
	});
});
