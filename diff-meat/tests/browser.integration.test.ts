import { describe, expect, test } from "vitest";
import { startReviewServer } from "@plannotator/pi-extension/server.ts";
import { compileReadingDiff, parsePatch, type DiffEditPlan } from "../patch";

const PATCH = `diff --git a/app.ts b/app.ts
--- a/app.ts
+++ b/app.ts
@@ -10,5 +10,5 @@ function run() {
 keepBefore();
-oldFirst();
+newFirst();
 omittedContext();
-oldSecond();
+newSecond();
`;

describe("Plannotator reading diff integration", () => {
	test("serves the mechanically compiled patch with stable source coordinates", async () => {
		const plan: DiffEditPlan = {
			remove: [{ startLine: 8, endLine: 8 }],
			fold: [],
			replace: [],
			dropFiles: [],
			summary: "Updates both calls.",
		};
		const reading = compileReadingDiff(parsePatch(PATCH), plan);
		expect(reading.rawPatch).toContain("@@ -10,2 +10,2 @@ function run() {");
		expect(reading.rawPatch).toContain("@@ -13 +13 @@ function run() {");

		const server = await startReviewServer({
			rawPatch: reading.rawPatch,
			gitRef: plan.summary,
			htmlContent: "<!doctype html><title>diff-meat test</title>",
			origin: "pi",
			agentCwd: process.cwd(),
		});
		try {
			const response = await fetch(`${server.url}/api/diff`);
			expect(response.ok).toBe(true);
			const payload = await response.json() as { rawPatch: string; gitRef: string };
			expect(payload.rawPatch).toBe(reading.rawPatch);
			expect(payload.gitRef).toBe("Updates both calls.");
		} finally {
			server.stop();
		}
	}, 15_000);
});
