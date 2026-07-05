import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { buildReviewInstructionsPrompt, loadProjectReviewGuidelines } from "../prompts";

describe("project review guidelines", () => {
	test("skips project guidelines when the project is not trusted", async () => {
		const baseDir = mkdtempSync(path.join(tmpdir(), "review-prompts-"));
		try {
			const cwd = path.join(baseDir, "repo");
			mkdirSync(path.join(cwd, CONFIG_DIR_NAME), { recursive: true });
			writeFileSync(path.join(cwd, "REVIEW_GUIDELINES.md"), "Project-specific guideline", "utf8");

			await expect(loadProjectReviewGuidelines(cwd, { projectTrusted: true })).resolves.toBe(
				"Project-specific guideline",
			);
			await expect(loadProjectReviewGuidelines(cwd, { projectTrusted: false })).resolves.toBeNull();

			const prompt = await buildReviewInstructionsPrompt(cwd, { projectTrusted: false });
			expect(prompt).not.toContain("Project-specific guideline");
		} finally {
			rmSync(baseDir, { recursive: true, force: true });
		}
	});
});
