import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getReviewCommentsForRun } from "./comments";
import { isGitRepository } from "./git";
import { buildReviewEditorPrompt, buildReviewInstructionsPrompt, describeReviewTarget } from "./prompts";
import { hasEntryInSession, getFirstUserMessageId } from "./state";
import { checkoutPullRequestTarget, resolveReviewTarget } from "./target-selector";
import { runReviewTriage } from "./triage-tui";
import type { ReviewComment, ReviewModeState, ReviewTarget, TriagedReviewComment } from "./types";
import { formatReviewSummaryMessage, createReviewRunId, REVIEW_MODE_START_OPTIONS } from "./utils";

type ReviewModeStateManager = {
	getState: () => ReviewModeState;
	setState: (ctx: ExtensionContext, nextState: ReviewModeState) => void;
	startReviewMode: (
		ctx: ExtensionContext,
		options: {
			originLeafId?: string;
			runId: string;
			targetHint: string;
			reviewInstructionsPrompt: string;
			originModelProvider?: string;
			originModelId?: string;
			originThinkingLevel?: string;
		},
	) => void;
};

export const REVIEW_SUMMARY_ENTRY_TYPE = "review-mode:summary";
export const REVIEW_PROMPT_ENTRY_TYPE = "review-mode:prompt";

export type ReviewPromptDetails = {
	targetHint: string;
	instructionsPrompt: string;
};

export type ReviewEndSummary = {
	runId: string;
	targetHint?: string;
	kept: TriagedReviewComment[];
	discardedCount: number;
	totalCount: number;
};

type ReviewFlowDependencies = {
	isGitRepository: (pi: ExtensionAPI, cwd: string) => Promise<boolean>;
	resolveTarget: (pi: ExtensionAPI, ctx: ExtensionContext, args: string) => Promise<ReviewTarget | null>;
	checkoutTarget: (pi: ExtensionAPI, ctx: ExtensionContext, target: ReviewTarget) => Promise<boolean>;
	buildInstructionsPrompt: (cwd: string) => Promise<string>;
	buildEditorPrompt: (pi: ExtensionAPI, cwd: string, target: ReviewTarget) => Promise<string>;
	describeTarget: (target: ReviewTarget) => string;
	getCommentsForRun: (ctx: ExtensionContext, runId: string) => ReviewComment[];
	runTriage: (ctx: ExtensionContext, comments: ReviewComment[], targetHint?: string) => Promise<{
		comments: TriagedReviewComment[];
		keptCount: number;
		discardedCount: number;
	} | null>;
	formatSummary: (options: {
		targetHint?: string;
		kept: TriagedReviewComment[];
		discardedCount: number;
		totalCount: number;
	}) => string;
};

const defaultDependencies: ReviewFlowDependencies = {
	isGitRepository,
	resolveTarget: resolveReviewTarget,
	checkoutTarget: checkoutPullRequestTarget,
	buildInstructionsPrompt: buildReviewInstructionsPrompt,
	buildEditorPrompt: buildReviewEditorPrompt,
	describeTarget: describeReviewTarget,
	getCommentsForRun: getReviewCommentsForRun,
	runTriage: runReviewTriage,
	formatSummary: formatReviewSummaryMessage,
};

async function navigateToFreshReviewBranch(ctx: ExtensionContext, cancelMessage: string): Promise<boolean> {
	const firstUserMessageId = getFirstUserMessageId(ctx);
	if (!firstUserMessageId) {
		ctx.ui.notify("No user message found to branch review from.", "error");
		return false;
	}

	try {
		const navigateResult = await ctx.navigateTree(firstUserMessageId, {
			summarize: false,
			label: "review-mode",
		});
		if (navigateResult.cancelled) {
			ctx.ui.notify(cancelMessage, "info");
			return false;
		}
	} catch (error) {
		ctx.ui.notify(
			`Failed to create a fresh review branch: ${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
		return false;
	}

	if (ctx.hasUI) {
		ctx.ui.setEditorText("");
	}
	return true;
}

async function restoreOriginAfterStartFailure(ctx: ExtensionContext, originLeafId: string | undefined): Promise<void> {
	if (!originLeafId || !hasEntryInSession(ctx, originLeafId)) {
		return;
	}

	try {
		const navigateResult = await ctx.navigateTree(originLeafId, {
			summarize: false,
			label: "review-mode",
		});
		if (navigateResult.cancelled) {
			ctx.ui.notify(
				"Returning to the origin branch was cancelled. Staying on the temporary branch.",
				"warning",
			);
		}
	} catch (error) {
		ctx.ui.notify(
			`Could not restore origin point: ${error instanceof Error ? error.message : String(error)}`,
			"warning",
		);
	}
}

async function restoreModelAndThinkingIfNeeded(pi: ExtensionAPI, ctx: ExtensionContext, state: ReviewModeState): Promise<void> {
	const restoredLabels: string[] = [];

	const shouldRestoreModel =
		!!state.originModelProvider &&
		!!state.originModelId &&
		(ctx.model?.provider !== state.originModelProvider || ctx.model?.id !== state.originModelId);

	if (shouldRestoreModel) {
		const model = ctx.modelRegistry.find(state.originModelProvider!, state.originModelId!);
		if (!model) {
			ctx.ui.notify(
				`Review mode ended. Could not restore model ${state.originModelProvider}/${state.originModelId} because it is unavailable.`,
				"warning",
			);
		} else {
			const switched = await pi.setModel(model);
			if (switched) {
				restoredLabels.push(`model ${state.originModelProvider}/${state.originModelId}`);
			} else {
				ctx.ui.notify(
					`Review mode ended. Could not restore model ${state.originModelProvider}/${state.originModelId}.`,
					"warning",
				);
			}
		}
	}

	if (state.originThinkingLevel) {
		const currentThinkingLevel = pi.getThinkingLevel();
		if (currentThinkingLevel !== state.originThinkingLevel) {
			pi.setThinkingLevel(state.originThinkingLevel as ReturnType<ExtensionAPI["getThinkingLevel"]>);
			if (pi.getThinkingLevel() === state.originThinkingLevel) {
				restoredLabels.push(`thinking ${state.originThinkingLevel}`);
			} else {
				ctx.ui.notify(
					`Review mode ended. Could not fully restore thinking level to ${state.originThinkingLevel}.`,
					"warning",
				);
			}
		}
	}

	if (restoredLabels.length > 0) {
		ctx.ui.notify(`Review mode ended. Restored ${restoredLabels.join(" and ")}.`, "info");
	}
}

function canOfferEmptyBranchStart(ctx: ExtensionContext, originLeafId: string | undefined): boolean {
	const firstUserMessageId = getFirstUserMessageId(ctx);
	return Boolean(originLeafId && firstUserMessageId && firstUserMessageId !== originLeafId);
}

export async function startReviewMode(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	args: string,
	stateManager: ReviewModeStateManager,
	dependencies: ReviewFlowDependencies,
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("Review mode requires interactive mode.", "error");
		return;
	}

	const inGitRepository = await dependencies.isGitRepository(pi, ctx.cwd);
	if (!inGitRepository) {
		ctx.ui.notify("Not a git repository.", "error");
		return;
	}

	await ctx.waitForIdle();

	const rawArgs = args.trim();
	const shouldRetryTargetSelection = rawArgs.length === 0;
	let resolveArgs = rawArgs;
	const originLeafId = ctx.sessionManager.getLeafId() ?? undefined;
	const canStartFromEmptyBranch = canOfferEmptyBranchStart(ctx, originLeafId);
	let useFreshBranch = false;

	if (canStartFromEmptyBranch) {
		const choice = await ctx.ui.select("Start review in:", [...REVIEW_MODE_START_OPTIONS]);
		if (choice === undefined) {
			ctx.ui.notify("Review cancelled.", "info");
			return;
		}
		useFreshBranch = choice === REVIEW_MODE_START_OPTIONS[0];
	}

	if (useFreshBranch) {
		if (!originLeafId) {
			ctx.ui.notify("Could not determine origin point for returning from review.", "error");
			return;
		}

		const movedToFreshBranch = await navigateToFreshReviewBranch(ctx, "Review cancelled.");
		if (!movedToFreshBranch) {
			return;
		}
	}

	let target: ReviewTarget | null = null;
	while (true) {
		target = await dependencies.resolveTarget(pi, ctx, resolveArgs);
		if (!target) {
			if (useFreshBranch) {
				await restoreOriginAfterStartFailure(ctx, originLeafId);
			}
			if (shouldRetryTargetSelection) {
				ctx.ui.notify("Review cancelled.", "info");
			}
			return;
		}

		const targetReady = await dependencies.checkoutTarget(pi, ctx, target);
		if (targetReady) {
			break;
		}

		if (!shouldRetryTargetSelection) {
			if (useFreshBranch) {
				await restoreOriginAfterStartFailure(ctx, originLeafId);
			}
			return;
		}

		ctx.ui.notify("Please select a different review target.", "info");
		resolveArgs = "";
	}

	if (!target) {
		ctx.ui.notify("Review cancelled.", "info");
		return;
	}

	const runId = createReviewRunId();
	const targetHint = dependencies.describeTarget(target);
	const reviewInstructionsPrompt = await dependencies.buildInstructionsPrompt(ctx.cwd);
	const editorPrompt = await dependencies.buildEditorPrompt(pi, ctx.cwd, target);

	stateManager.startReviewMode(ctx, {
		originLeafId,
		runId,
		targetHint,
		reviewInstructionsPrompt,
		originModelProvider: ctx.model?.provider,
		originModelId: ctx.model?.id,
		originThinkingLevel: pi.getThinkingLevel(),
	});

	const modeSuffix = useFreshBranch ? " (empty branch)" : "";
	ctx.ui.setEditorText(editorPrompt);
	pi.sendMessage({
		customType: REVIEW_PROMPT_ENTRY_TYPE,
		content: "Review instructions",
		display: true,
		details: {
			targetHint,
			instructionsPrompt: reviewInstructionsPrompt,
		} satisfies ReviewPromptDetails,
	});
	ctx.ui.notify(`Review mode ready: ${targetHint}${modeSuffix}. Edit and send when ready.`, "info");
}

export async function endReviewMode(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	stateManager: ReviewModeStateManager,
	dependencies: ReviewFlowDependencies,
	onReviewEnded?: (summary: ReviewEndSummary) => void,
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("Ending review mode requires interactive mode.", "error");
		return;
	}

	const state = stateManager.getState();
	if (!state.active || !state.runId) {
		ctx.ui.notify("Review mode is not active.", "info");
		return;
	}

	await ctx.waitForIdle();

	const collectedComments = dependencies.getCommentsForRun(ctx, state.runId);
	const triageResult = await dependencies.runTriage(ctx, collectedComments, state.targetHint);
	if (!triageResult) {
		ctx.ui.notify("Review mode end cancelled. Continuing review mode.", "info");
		return;
	}

	const reviewLeafId = ctx.sessionManager.getLeafId() ?? state.lastReviewLeafId;
	const originLeafId = state.originLeafId;
	if (originLeafId && originLeafId !== reviewLeafId && hasEntryInSession(ctx, originLeafId)) {
		try {
			const navigateResult = await ctx.navigateTree(originLeafId, { summarize: false, label: "review-mode" });
			if (navigateResult.cancelled) {
				ctx.ui.notify("Returning from review mode was cancelled. Staying in review mode.", "info");
				return;
			}
		} catch (error) {
			ctx.ui.notify(
				`Failed to restore origin point: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return;
		}
	} else if (originLeafId && !hasEntryInSession(ctx, originLeafId)) {
		ctx.ui.notify("Origin point is unavailable. Ending review mode at the current branch tip.", "warning");
	}

	stateManager.setState(ctx, {
		version: state.version,
		active: false,
		lastReviewLeafId: reviewLeafId,
	});
	await restoreModelAndThinkingIfNeeded(pi, ctx, state);

	const keptComments = triageResult.comments.filter((comment) => comment.keep);
	const summary: ReviewEndSummary = {
		runId: state.runId,
		targetHint: state.targetHint,
		kept: keptComments,
		discardedCount: triageResult.discardedCount,
		totalCount: triageResult.comments.length,
	};
	if (summary.kept.length === 0) {
		ctx.ui.notify("Review mode ended. No review comments were collected.", "info");
		onReviewEnded?.(summary);
		return;
	}

	const summaryText = dependencies.formatSummary({
		targetHint: summary.targetHint,
		kept: summary.kept,
		discardedCount: summary.discardedCount,
		totalCount: summary.totalCount,
	});

	const prefillLines = [
		summary.kept.length === 1 ? "Address the review comment" : "Address the review comments",
	];
	if (summary.kept.some((comment) => comment.note?.trim())) {
		prefillLines.push("", "Pay attention to the user notes in response to the review comments");
	}
	ctx.ui.setEditorText(prefillLines.join("\n"));

	pi.sendMessage({
		customType: REVIEW_SUMMARY_ENTRY_TYPE,
		content: summaryText,
		display: true,
		details: summary,
	});
	onReviewEnded?.(summary);
}

export function registerReviewCommand(
	pi: ExtensionAPI,
	dependencies: {
		stateManager: ReviewModeStateManager;
		onReviewEnded?: (summary: ReviewEndSummary) => void;
		flow?: Partial<ReviewFlowDependencies>;
	},
) {
	const flowDependencies: ReviewFlowDependencies = {
		...defaultDependencies,
		...dependencies.flow,
	};

	pi.registerCommand("review", {
		description: "Toggle review mode. Starts review mode when inactive and ends it when active.",
		handler: async (args, ctx) => {
			const state = dependencies.stateManager.getState();
			if (state.active) {
				await endReviewMode(pi, ctx, dependencies.stateManager, flowDependencies, dependencies.onReviewEnded);
				return;
			}

			await startReviewMode(pi, ctx, args.trim(), dependencies.stateManager, flowDependencies);
		},
	});
}
