import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CodeReviewResult, PreparedDiff, ReadingDiff } from "./types";

export async function openReadingDiffReview(
	ctx: ExtensionContext,
	cwd: string,
	prepared: PreparedDiff,
	reading: ReadingDiff,
): Promise<CodeReviewResult> {
	const [serverModule, browserRuntime, browserModule] = await Promise.all([
		import("@plannotator/pi-extension/server.ts"),
		import("@plannotator/pi-extension/plannotator-browser-runtime.ts"),
		import("@plannotator/pi-extension/plannotator-browser.ts"),
	]);
	const htmlContent = browserRuntime.getReviewBrowserHtml();
	if (!htmlContent) {
		throw new Error("Plannotator code review browser is unavailable in this session.");
	}

	const gitRef = reading.summary || `${prepared.gitRef} reading diff`;
	const server = await browserModule.startServerWithSelfPreemption(() => serverModule.startReviewServer({
		rawPatch: reading.rawPatch,
		gitRef,
		htmlContent,
		origin: "pi",
		diffType: prepared.diffType,
		agentCwd: cwd,
	}));
	const session = browserModule.startBrowserDecisionSession(server, ctx, server.waitForDecision);
	return await session.waitForDecision();
}
