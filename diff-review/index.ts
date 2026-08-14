import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { startCodeReviewBrowserSession } from "@plannotator/pi-extension/plannotator-events.ts";
import {
	handlePlannotatorDecision,
	registerPlannotatorFeedbackRenderer,
} from "@siddr/pi-shared-qna/plannotator-feedback";
import {
	hasHeadCommit,
	isGitRepository,
	resolveDiffTargetFromArgs,
	type DiffTarget,
} from "@siddr/pi-shared-qna/diff-target";
import {
	preparePlannotatorBrowserSession,
	preparePlannotatorContext,
} from "@siddr/pi-shared-qna/plannotator-url";
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
	preparePlannotatorContext: (ctx: ExtensionContext) => Promise<ExtensionContext>;
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

async function openCodeReview(
	ctx: ExtensionContext,
	options: Parameters<OpenCodeReview>[1],
): Promise<CodeReviewResult> {
	const session = await startCodeReviewBrowserSession(ctx, options);
	const preparedSession = await preparePlannotatorBrowserSession(ctx, session);
	return await preparedSession.waitForDecision();
}

function createDefaultDependencies(): DiffReviewExtensionDependencies {
	return {
		isGitRepository,
		hasHeadCommit,
		resolveDiffTargetFromArgs,
		preparePlannotatorContext,
		openCodeReview,
		openUnbornRepoReview,
	};
}

export function createDiffReviewExtension(overrides: Partial<DiffReviewExtensionDependencies> = {}) {
	const dependencies = { ...createDefaultDependencies(), ...overrides } satisfies DiffReviewExtensionDependencies;

	return function (pi: ExtensionAPI) {
		const runReview = async (args: string, ctx: ExtensionContext) => {
			try {
				if (!(await dependencies.isGitRepository(pi, ctx.cwd))) {
					notify(ctx, "This command only works inside a git repository.", "error");
					return;
				}

				const target = await dependencies.resolveDiffTargetFromArgs(pi, ctx, args);
				if (!target) {
					return;
				}

				const plannotatorCtx = await dependencies.preparePlannotatorContext(ctx);
				const reviewOptions = buildCodeReviewOptions(ctx.cwd, target);
				const result = reviewOptions.diffType === "uncommitted" && !(await dependencies.hasHeadCommit(pi, ctx.cwd))
					? await dependencies.openUnbornRepoReview(pi, plannotatorCtx, ctx.cwd)
					: await dependencies.openCodeReview(plannotatorCtx, reviewOptions);
				await handlePlannotatorDecision(pi, ctx, result, {
					delivery: "steer",
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
		};

		registerPlannotatorFeedbackRenderer(pi);
		pi.registerCommand(REVIEW_COMMAND, {
			description: "Open a Plannotator browser diff review",
			handler: (args, ctx) => {
				if (!ctx.hasUI) {
					return;
				}

				void runReview(args, ctx);
			},
		});
	};
}

export default createDiffReviewExtension();
