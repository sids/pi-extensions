import path from "node:path";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isTuiMode } from "@siddr/pi-shared-qna/extension-mode";
import { isProjectTrusted } from "@siddr/pi-shared-qna/project-trust";
import { summarizeLoadedContext } from "@siddr/pi-shared-qna/system-prompt-diagnostic";
import { runReviewAutoSelect } from "./auto-select-tui";
import { summarizeChangesFromSessionHistory } from "./change-summary";
import { getReviewCommentsForRun } from "./comments";
import { isGitRepository } from "./git";
import type { ReviewLifecyclePhase } from "./lifecycle";
import { buildReviewEditorPrompt, buildReviewInstructionsPrompt, describeReviewTarget } from "./prompts";
import { runReviewPromptCountdown, type ReviewPromptCountdownDecision } from "./prompt-tui";
import { hasEntryInSession, getFirstUserMessageId } from "./state";
import { checkoutPullRequestTarget, resolveReviewTarget } from "./target-selector";
import { runReviewTriage } from "./triage-tui";
import type {
	ReviewComment,
	ReviewModeState,
	ReviewTarget,
	ReviewTriageResult,
	TriagedReviewComment,
} from "./types";
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
			targetPrNumber?: number;
			targetPrRef?: string;
			reviewInstructionsPrompt: string;
			originModelProvider?: string;
			originModelId?: string;
			originThinkingLevel?: string;
		},
	) => void;
};

export const REVIEW_SUMMARY_ENTRY_TYPE = "review-mode:summary";
export const REVIEW_PROMPT_ENTRY_TYPE = "review-mode:prompt";
export const REVIEW_CHANGE_SUMMARY_ENTRY_TYPE = "review-mode:change-summary";

export type ReviewPromptDetails = {
	runId?: string;
	targetHint: string;
	instructionsPrompt: string;
};

export type ReviewChangeSummaryDetails = {
	runId?: string;
	targetHint: string;
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
	selectStartLocation: (ctx: ExtensionContext) => Promise<string | undefined>;
	checkoutTarget: (pi: ExtensionAPI, ctx: ExtensionContext, target: ReviewTarget) => Promise<boolean>;
	buildInstructionsPrompt: (cwd: string, options?: { projectTrusted?: boolean }) => Promise<string>;
	buildEditorPrompt: (pi: ExtensionAPI, cwd: string, target: ReviewTarget) => Promise<string>;
	describeTarget: (target: ReviewTarget) => string;
	summarizeChangesFromSessionHistory: (
		ctx: ExtensionContext,
		sourceLeafId: string | undefined,
		options?: { signal?: AbortSignal },
	) => Promise<string | null>;
	getActivePlanFilePath: (ctx: ExtensionContext) => string | undefined;
	getCommentsForRun: (ctx: ExtensionContext, runId: string) => ReviewComment[];
	runTriage: (ctx: ExtensionContext, comments: ReviewComment[], targetHint?: string) => Promise<{
		comments: TriagedReviewComment[];
		keptCount: number;
		discardedCount: number;
	} | null>;
	runPromptCountdown: (
		ctx: ExtensionContext,
		prompt: string,
		title: string,
	) => Promise<ReviewPromptCountdownDecision>;
	setLifecyclePhase: (phase: ReviewLifecyclePhase, runId?: string) => void;
	formatSummary: (options: {
		targetHint?: string;
		kept: TriagedReviewComment[];
		discardedCount: number;
		totalCount: number;
	}) => string;
};

type PlanModeState = {
	version: number;
	active: boolean;
	planFilePath?: string;
};

const PLAN_MODE_STATE_ENTRY_TYPE = "plan-md:state";
const PLAN_MODE_STATE_VERSION = 1;

function isPlanModeState(value: unknown): value is PlanModeState {
	if (!value || typeof value !== "object") {
		return false;
	}

	const state = value as Partial<PlanModeState>;
	return state.version === PLAN_MODE_STATE_VERSION && typeof state.active === "boolean";
}

function getPlanFilePathForSession(ctx: ExtensionContext): string {
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile) {
		return path.join(ctx.sessionManager.getSessionDir(), `${ctx.sessionManager.getSessionId()}.plan.md`);
	}

	const parsed = path.parse(sessionFile);
	return path.join(parsed.dir, `${parsed.name}.plan.md`);
}

function resolvePlanFilePathForReview(ctx: ExtensionContext, planFilePath: string | undefined): string {
	if (planFilePath && planFilePath.trim().length > 0) {
		return planFilePath;
	}
	return getPlanFilePathForSession(ctx);
}

function getActivePlanFilePath(ctx: ExtensionContext): string | undefined {
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== PLAN_MODE_STATE_ENTRY_TYPE) {
			continue;
		}
		if (!isPlanModeState(entry.data)) {
			continue;
		}
		return entry.data.active ? resolvePlanFilePathForReview(ctx, entry.data.planFilePath) : undefined;
	}
	return undefined;
}

function addActivePlanStatement(editorPrompt: string, planFilePath: string | undefined): string {
	if (!planFilePath) {
		return editorPrompt;
	}

	return [
		editorPrompt,
		"",
		`The changes under review are implementing the plan in: ${planFilePath}`,
	].join("\n");
}

function addChangeSummary(editorPrompt: string, changeSummary: string | null): string {
	if (!changeSummary?.trim()) {
		return editorPrompt;
	}

	return [editorPrompt, "", changeSummary.trim()].join("\n");
}

const defaultDependencies: ReviewFlowDependencies = {
	isGitRepository,
	resolveTarget: resolveReviewTarget,
	selectStartLocation: (ctx) =>
		runReviewAutoSelect(
			ctx,
			"Start review in:",
			REVIEW_MODE_START_OPTIONS.map((option) => ({ value: option, label: option })),
			REVIEW_MODE_START_OPTIONS[0],
		),
	checkoutTarget: checkoutPullRequestTarget,
	buildInstructionsPrompt: buildReviewInstructionsPrompt,
	buildEditorPrompt: buildReviewEditorPrompt,
	describeTarget: describeReviewTarget,
	summarizeChangesFromSessionHistory,
	getActivePlanFilePath,
	getCommentsForRun: getReviewCommentsForRun,
	runTriage: runReviewTriage,
	runPromptCountdown: runReviewPromptCountdown,
	setLifecyclePhase: () => {},
	formatSummary: formatReviewSummaryMessage,
};

type ReviewChangeSummaryResult =
	| { status: "completed"; summary: string | null }
	| { status: "cancelled" }
	| { status: "failed"; error: unknown };

async function runCancellableChangeSummary(
	ctx: ExtensionContext,
	sourceLeafId: string | undefined,
	summarize: ReviewFlowDependencies["summarizeChangesFromSessionHistory"],
): Promise<ReviewChangeSummaryResult> {
	return ctx.ui.custom<ReviewChangeSummaryResult>((tui, theme, _keybindings, done) => {
		const loader = new BorderedLoader(tui, theme, "Summarizing changes from session history...");
		let settled = false;
		const finish = (result: ReviewChangeSummaryResult) => {
			if (settled) {
				return;
			}
			settled = true;
			done(result);
		};

		loader.onAbort = () => finish({ status: "cancelled" });
		void Promise.resolve()
			.then(() => summarize(ctx, sourceLeafId, { signal: loader.signal }))
			.then((summary) => finish({ status: "completed", summary }))
			.catch((error) => {
				if (loader.signal.aborted) {
					finish({ status: "cancelled" });
					return;
				}
				finish({ status: "failed", error });
			});

		return loader;
	});
}

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

	if (isTuiMode(ctx)) {
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

function getReviewPrReference(state: ReviewModeState): string | undefined {
	if (state.targetPrRef?.trim()) {
		const targetPrRef = state.targetPrRef.trim();
		return /^\d+$/.test(targetPrRef) ? `#${targetPrRef}` : targetPrRef;
	}

	if (state.targetPrNumber) {
		return `#${state.targetPrNumber}`;
	}

	const match = state.targetHint?.match(/^PR #(\d+)(?:\b|:)/);
	if (!match) {
		return undefined;
	}

	const prNumber = Number.parseInt(match[1], 10);
	return Number.isInteger(prNumber) && prNumber > 0 ? `#${prNumber}` : undefined;
}

export async function startReviewMode(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	args: string,
	stateManager: ReviewModeStateManager,
	dependencies: ReviewFlowDependencies,
): Promise<void> {
	if (!isTuiMode(ctx)) {
		if (ctx.hasUI) {
			ctx.ui.notify("Review mode requires TUI mode.", "error");
		}
		return;
	}

	const inGitRepository = await dependencies.isGitRepository(pi, ctx.cwd);
	if (!inGitRepository) {
		ctx.ui.notify("Not a git repository.", "error");
		return;
	}

	if (!ctx.isIdle()) {
		ctx.ui.notify("Review mode will start after the current agent run finishes.", "info");
	}
	await ctx.waitForIdle();

	const rawArgs = args.trim();
	const shouldRetryTargetSelection = rawArgs.length === 0;
	let resolveArgs = rawArgs;
	const originLeafId = ctx.sessionManager.getLeafId() ?? undefined;
	const activePlanFilePath = dependencies.getActivePlanFilePath(ctx);
	const canStartFromEmptyBranch = canOfferEmptyBranchStart(ctx, originLeafId);
	let useFreshBranch = false;

	if (canStartFromEmptyBranch) {
		const choice = await dependencies.selectStartLocation(ctx);
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
	let changeSummary: string | null = null;
	if (useFreshBranch && target.type === "uncommitted") {
		dependencies.setLifecyclePhase("summarizing");
		const summaryResult = await runCancellableChangeSummary(
			ctx,
			originLeafId,
			dependencies.summarizeChangesFromSessionHistory,
		).catch((error) => ({ status: "failed" as const, error }));
		if (summaryResult.status === "completed") {
			changeSummary = summaryResult.summary;
			if (!changeSummary) {
				ctx.ui.notify("Could not summarize changes from session history. Continuing review startup.", "warning");
			}
		} else if (summaryResult.status === "cancelled") {
			ctx.ui.notify("Change summary cancelled. Continuing review startup.", "info");
		} else {
			const error = summaryResult.error;
			ctx.ui.notify(
				`Could not summarize changes from session history: ${error instanceof Error ? error.message : String(error)}. Continuing review startup.`,
				"warning",
			);
		}
	}
	const reviewInstructionsPrompt = await dependencies.buildInstructionsPrompt(ctx.cwd, {
		projectTrusted: isProjectTrusted(ctx),
	});
	const targetEditorPrompt = await dependencies.buildEditorPrompt(pi, ctx.cwd, target);
	const editorPrompt = addChangeSummary(
		addActivePlanStatement(targetEditorPrompt, useFreshBranch ? activePlanFilePath : undefined),
		changeSummary,
	);

	stateManager.startReviewMode(ctx, {
		originLeafId,
		runId,
		targetHint,
		...(target.type === "pullRequest"
			? { targetPrNumber: target.prNumber, targetPrRef: target.ghRef?.trim() || String(target.prNumber) }
			: {}),
		reviewInstructionsPrompt,
		originModelProvider: ctx.model?.provider,
		originModelId: ctx.model?.id,
		originThinkingLevel: pi.getThinkingLevel(),
	});
	dependencies.setLifecyclePhase("reviewing", runId);

	const modeSuffix = useFreshBranch ? " (empty branch)" : "";
	pi.sendMessage({
		customType: REVIEW_PROMPT_ENTRY_TYPE,
		content: "Review instructions",
		display: true,
		details: {
			runId,
			targetHint,
			instructionsPrompt: reviewInstructionsPrompt,
		} satisfies ReviewPromptDetails,
	});
	const contextSummary = summarizeLoadedContext(ctx);
	const contextNote = contextSummary ? ` (${contextSummary})` : "";
	const promptDecision = await dependencies.runPromptCountdown(
		ctx,
		editorPrompt,
		`Start review · ${targetHint}`,
	);
	if (promptDecision === "submit") {
		ctx.ui.notify(`Review mode started: ${targetHint}${modeSuffix}${contextNote}.`, "info");
		pi.sendUserMessage(editorPrompt);
		return;
	}

	ctx.ui.setEditorText(editorPrompt);
	ctx.ui.notify(`Review mode ready: ${targetHint}${modeSuffix}${contextNote}. Edit and send when ready.`, "info");
}

export async function endReviewMode(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	stateManager: ReviewModeStateManager,
	dependencies: ReviewFlowDependencies,
	onReviewEnded?: (summary: ReviewEndSummary) => void,
	options: { automatic?: boolean; triageResult?: ReviewTriageResult } = {},
): Promise<void> {
	if (!isTuiMode(ctx)) {
		if (ctx.hasUI) {
			ctx.ui.notify("Ending review mode requires TUI mode.", "error");
		}
		return;
	}

	const state = stateManager.getState();
	if (!state.active || !state.runId) {
		ctx.ui.notify("Review mode is not active.", "info");
		return;
	}

	await ctx.waitForIdle();

	const collectedComments = dependencies.getCommentsForRun(ctx, state.runId);
	const triageResult = options.triageResult
		?? await dependencies.runTriage(ctx, collectedComments, state.targetHint);
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

	const reviewPrReference = getReviewPrReference(state);
	let followUpPrompt: string;
	if (options.automatic) {
		followUpPrompt = reviewPrReference
			? `Exercise your judgment as to which review comments to accept. Use the gh cli to add the comments you accept as inline comments on PR ${reviewPrReference}.`
			: "Exercise your judgment as to which review comments to accept. Address the comments you accept.";
	} else if (reviewPrReference) {
		followUpPrompt = `Use the gh cli to add these as inline comments on PR ${reviewPrReference}.`;
	} else {
		const prefillLines = [
			summary.kept.length === 1 ? "Address the review comment" : "Address the review comments",
		];
		if (summary.kept.some((comment) => comment.note?.trim())) {
			prefillLines.push("", "Pay attention to the user notes in response to the review comments");
		}
		followUpPrompt = prefillLines.join("\n");
	}

	pi.sendMessage({
		customType: REVIEW_SUMMARY_ENTRY_TYPE,
		content: summaryText,
		display: true,
		details: summary,
	});
	onReviewEnded?.(summary);

	if (options.automatic) {
		pi.sendUserMessage(followUpPrompt);
		return;
	}

	const promptDecision = await dependencies.runPromptCountdown(
		ctx,
		followUpPrompt,
		"Continue after review",
	);
	if (promptDecision === "submit") {
		pi.sendUserMessage(followUpPrompt);
		return;
	}
	ctx.ui.setEditorText(followUpPrompt);
}

export type AutomaticReviewEndResult = "ended" | "cancelled" | "unavailable";

export type ReviewCommandController = {
	endAutomatically: (runId: string, triageResult: ReviewTriageResult) => Promise<AutomaticReviewEndResult>;
};

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
	let commandContext: ExtensionCommandContext | undefined;
	let pendingAutomaticTriage: { runId: string; result: ReviewTriageResult } | undefined;

	const runEnd = async (
		ctx: ExtensionCommandContext,
		state: ReviewModeState,
		options: { automatic: boolean; triageResult?: ReviewTriageResult },
	): Promise<boolean> => {
		flowDependencies.setLifecyclePhase("ending", state.runId);
		try {
			await endReviewMode(
				pi,
				ctx,
				dependencies.stateManager,
				flowDependencies,
				dependencies.onReviewEnded,
				options,
			);
		} finally {
			const currentState = dependencies.stateManager.getState();
			flowDependencies.setLifecyclePhase(
				currentState.active ? "reviewing" : "inactive",
				currentState.runId,
			);
		}
		return !dependencies.stateManager.getState().active;
	};

	pi.registerCommand("review", {
		description: "Toggle review mode. Starts review mode when inactive and ends it when active.",
		handler: async (args, ctx) => {
			commandContext = ctx;
			const state = dependencies.stateManager.getState();
			if (state.active) {
				const automaticTriage = pendingAutomaticTriage?.runId === state.runId
					? pendingAutomaticTriage.result
					: undefined;
				pendingAutomaticTriage = undefined;
				await runEnd(ctx, state, {
					automatic: Boolean(automaticTriage),
					...(automaticTriage ? { triageResult: automaticTriage } : {}),
				});
				return;
			}

			flowDependencies.setLifecyclePhase("selecting");
			try {
				await startReviewMode(pi, ctx, args.trim(), dependencies.stateManager, flowDependencies);
			} finally {
				if (!dependencies.stateManager.getState().active) {
					flowDependencies.setLifecyclePhase("inactive");
				}
			}
		},
	});

	return {
		endAutomatically: async (runId: string, triageResult: ReviewTriageResult) => {
			const state = dependencies.stateManager.getState();
			if (!state.active || state.runId !== runId) {
				return "unavailable";
			}
			if (!commandContext) {
				pendingAutomaticTriage = { runId, result: triageResult };
				return "unavailable";
			}
			return await runEnd(commandContext, state, { automatic: true, triageResult }) ? "ended" : "cancelled";
		},
	} satisfies ReviewCommandController;
}
