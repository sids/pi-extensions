import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { openCodeReview } from "@plannotator/pi-extension/plannotator-events.ts";
import {
	handlePlannotatorDecision,
	registerPlannotatorFeedbackRenderer,
} from "@siddr/pi-shared-qna/plannotator-feedback";
import { preparePlannotatorContext } from "@siddr/pi-shared-qna/plannotator-url";
import { hasHeadCommit, isGitRepository } from "./git";
import { resolveDiffTargetFromArgs } from "./target-selector";
import type { DiffTarget } from "./types";
import { openUnbornRepoReview } from "./unborn-review";

export type CodeReviewResult = {
	approved: boolean;
	feedback?: string;
	exit?: boolean;
};

export type OpenCodeReview = (
	ctx: ExtensionContext,
	options: {
		cwd: string;
		diffType: "uncommitted" | "merge-base" | `commit:${string}`;
		defaultBranch?: string;
		vcsType: "git";
	},
) => Promise<CodeReviewResult>;

export type DiffReviewExtensionDependencies = {
	isGitRepository: typeof isGitRepository;
	hasHeadCommit: typeof hasHeadCommit;
	resolveDiffTargetFromArgs: typeof resolveDiffTargetFromArgs;
	openCodeReview: OpenCodeReview;
	openUnbornRepoReview: typeof openUnbornRepoReview;
};

const REVIEW_COMMAND = "diff-review";

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") {
	if (ctx.hasUI) {
		ctx.ui.notify(message, level);
	}
}

export function buildCodeReviewOptions(cwd: string, target: DiffTarget): Parameters<OpenCodeReview>[1] {
	switch (target.type) {
		case "uncommitted":
			return { cwd, diffType: "uncommitted", vcsType: "git" };
		case "baseBranch":
			return { cwd, diffType: "merge-base", defaultBranch: target.branch, vcsType: "git" };
		case "commit":
			return { cwd, diffType: `commit:${target.sha}`, vcsType: "git" };
	}
}

function createDefaultDependencies(): DiffReviewExtensionDependencies {
	return {
		isGitRepository,
		hasHeadCommit,
		resolveDiffTargetFromArgs,
		openCodeReview,
		openUnbornRepoReview,
	};
}

export function createDiffReviewExtension(overrides: Partial<DiffReviewExtensionDependencies> = {}) {
	const dependencies = { ...createDefaultDependencies(), ...overrides } satisfies DiffReviewExtensionDependencies;

	return function (pi: ExtensionAPI) {
		registerPlannotatorFeedbackRenderer(pi);
		pi.registerCommand(REVIEW_COMMAND, {
			description: "Open a Plannotator browser diff review",
			handler: async (args, ctx) => {
				if (!ctx.hasUI) {
					return;
				}

				if (!(await dependencies.isGitRepository(pi, ctx.cwd))) {
					notify(ctx, "This command only works inside a git repository.", "error");
					return;
				}

				const target = await dependencies.resolveDiffTargetFromArgs(pi, ctx, args);
				if (!target) {
					return;
				}

				try {
					const plannotatorCtx = await preparePlannotatorContext(ctx);
					const reviewOptions = buildCodeReviewOptions(ctx.cwd, target);
					const result = reviewOptions.diffType === "uncommitted" && !(await dependencies.hasHeadCommit(pi, ctx.cwd))
						? await dependencies.openUnbornRepoReview(pi, plannotatorCtx, ctx.cwd)
						: await dependencies.openCodeReview(plannotatorCtx, reviewOptions);
					await handlePlannotatorDecision(pi, ctx, result, {
						notifications: {
							approved: "Diff review approved.",
							closed: "Diff review closed.",
							empty: "Diff review closed without feedback.",
							sent: "Sent review feedback to the agent.",
						},
					});
				} catch (error) {
					const message = error instanceof Error ? error.message : "Failed to open the diff review.";
					notify(ctx, message, "error");
				}
			},
		});
	};
}

export default createDiffReviewExtension();
