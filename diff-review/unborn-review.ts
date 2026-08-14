import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildUnbornFilesPatch } from "@siddr/pi-shared-qna/git-patch";
import { preparePlannotatorBrowserSession } from "@siddr/pi-shared-qna/plannotator-url";
import type { CodeReviewResult } from "./index";

export function buildUnbornRepoPatch(pi: ExtensionAPI, cwd: string): Promise<string> {
	return buildUnbornFilesPatch(pi, cwd);
}

export async function openUnbornRepoReview(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	cwd: string,
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

	const rawPatch = await buildUnbornRepoPatch(pi, cwd);
	const server = await browserModule.startServerWithSelfPreemption(() => serverModule.startReviewServer({
		rawPatch,
		gitRef: "Uncommitted changes",
		htmlContent,
		origin: "pi",
		diffType: "uncommitted",
		agentCwd: cwd,
	}));
	const session = browserModule.startBrowserDecisionSession(server, ctx, server.waitForDecision);
	const preparedSession = await preparePlannotatorBrowserSession(ctx, session);
	return await preparedSession.waitForDecision();
}
