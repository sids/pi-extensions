import { describe, expect, test } from "vitest";
import { compareSidebarTreeEntries } from "../web/components/sidebar";
import type { FileTreeSortEntry } from "@pierre/trees";

function entry(path: string, isDirectory = false): FileTreeSortEntry {
	const segments = path.split("/");
	return {
		basename: segments.at(-1) ?? path,
		depth: segments.length,
		isDirectory,
		path,
		segments,
	};
}

describe("compareSidebarTreeEntries", () => {
	test("places root files before root directories", () => {
		const paths = [entry("diff-review", true), entry("README.md"), entry("pnpm-lock.yaml"), entry("answer", true)];
		expect([...paths].sort(compareSidebarTreeEntries).map((item) => item.path)).toEqual([
			"pnpm-lock.yaml",
			"README.md",
			"answer",
			"diff-review",
		]);
	});

	test("places files before directories below the root", () => {
		const paths = [entry("diff-review/README.md"), entry("diff-review/web", true), entry("diff-review/CHANGELOG.md")];
		expect([...paths].sort(compareSidebarTreeEntries).map((item) => item.path)).toEqual([
			"diff-review/CHANGELOG.md",
			"diff-review/README.md",
			"diff-review/web",
		]);
	});

	test("places files before nested file directories", () => {
		const paths = [entry("diff-review/web/app.tsx"), entry("diff-review/README.md"), entry("diff-review/CHANGELOG.md")];
		expect([...paths].sort(compareSidebarTreeEntries).map((item) => item.path)).toEqual([
			"diff-review/CHANGELOG.md",
			"diff-review/README.md",
			"diff-review/web/app.tsx",
		]);
	});
});
