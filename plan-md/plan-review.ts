import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	getStartupErrorMessage,
	startPlanReviewBrowserSession,
} from "@plannotator/pi-extension/plannotator-events.ts";
import {
	preparePlannotatorBrowserSession,
	preparePlannotatorContext,
} from "@siddr/pi-shared-qna/plannotator-url";

export type PlanReviewDecision = {
	approved: boolean;
	feedback?: string;
};

export type OpenPlanReview = (
	ctx: ExtensionContext,
	plan: string,
) => Promise<PlanReviewDecision>;

async function openPlanReview(
	ctx: ExtensionContext,
	plan: string,
): Promise<PlanReviewDecision> {
	const session = await startPlanReviewBrowserSession(ctx, plan);
	const preparedSession = await preparePlannotatorBrowserSession(ctx, session);
	return await preparedSession.waitForDecision();
}

export async function reviewPlanInBrowser(
	ctx: ExtensionContext,
	plan: string,
	openReview: OpenPlanReview = openPlanReview,
): Promise<PlanReviewDecision> {
	try {
		const plannotatorCtx = await preparePlannotatorContext(ctx);
		return await openReview(plannotatorCtx, plan);
	} catch (error) {
		throw new Error(`Failed to open plan review: ${getStartupErrorMessage(error)}`);
	}
}
