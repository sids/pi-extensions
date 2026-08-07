import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	getStartupErrorMessage,
	openPlanReviewBrowser,
} from "@plannotator/pi-extension/plannotator-events.ts";
import { preparePlannotatorContext } from "@siddr/pi-shared-qna/plannotator-url";

export type PlanReviewDecision = {
	approved: boolean;
	feedback?: string;
};

export type OpenPlanReview = (
	ctx: ExtensionContext,
	plan: string,
	signal?: AbortSignal,
) => Promise<PlanReviewDecision>;

export async function reviewPlanInBrowser(
	ctx: ExtensionContext,
	plan: string,
	signal?: AbortSignal,
	openReview: OpenPlanReview = openPlanReviewBrowser,
): Promise<PlanReviewDecision> {
	try {
		const plannotatorCtx = await preparePlannotatorContext(ctx);
		return await openReview(plannotatorCtx, plan, signal);
	} catch (error) {
		throw new Error(`Failed to open plan review: ${getStartupErrorMessage(error)}`);
	}
}
