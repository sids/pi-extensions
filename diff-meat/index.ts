import { BorderedLoader, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	handlePlannotatorDecision,
	registerPlannotatorFeedbackRenderer,
} from "@siddr/pi-shared-qna/plannotator-feedback";
import {
	isGitRepository,
	resolveDiffTargetFromArgs,
} from "@siddr/pi-shared-qna/diff-target";
import { preparePlannotatorContext } from "@siddr/pi-shared-qna/plannotator-url";
import { openReadingDiffReview } from "./browser";
import { formatModel, loadDiffMeatConfig, type DiffMeatConfig } from "./config";
import { buildDiffContext } from "./context";
import { prepareDiff } from "./diff";
import { abridgeDiff, type AbridgeDiffOptions } from "./meat";
import type { PlannerProgress } from "./planner";
import type { CodeReviewResult, PreparedDiff, ReadingDiff } from "./types";

export type { CodeReviewResult } from "./types";

export type DiffMeatExtensionDependencies = {
	isGitRepository: typeof isGitRepository;
	resolveDiffTargetFromArgs: typeof resolveDiffTargetFromArgs;
	preparePlannotatorContext: (ctx: ExtensionContext) => Promise<ExtensionContext>;
	prepareDiff: typeof prepareDiff;
	buildDiffContext: typeof buildDiffContext;
	loadConfig: () => DiffMeatConfig;
	abridgeDiff: (
		pi: ExtensionAPI,
		ctx: ExtensionContext,
		rawPatch: string,
		options?: AbridgeDiffOptions,
	) => Promise<ReadingDiff>;
	openReadingDiffReview: (
		ctx: ExtensionContext,
		cwd: string,
		prepared: PreparedDiff,
		reading: ReadingDiff,
	) => Promise<CodeReviewResult>;
};

const COMMAND = "diff-meat";
const STATUS = "diff-meat";

type AbridgeOutcome =
	| { status: "completed"; reading: ReadingDiff }
	| { status: "cancelled" }
	| { status: "failed"; error: unknown };

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") {
	if (ctx.hasUI) ctx.ui.notify(message, level);
}

function createDefaultDependencies(): DiffMeatExtensionDependencies {
	return {
		isGitRepository,
		resolveDiffTargetFromArgs,
		preparePlannotatorContext,
		prepareDiff,
		buildDiffContext,
		loadConfig: loadDiffMeatConfig,
		abridgeDiff,
		openReadingDiffReview,
	};
}

function progressStatus(ctx: ExtensionContext, modelLabel: string, progress: PlannerProgress): void {
	const usage = `${progress.usage.input.toLocaleString()} in · ${progress.usage.output.toLocaleString()} out`;
	ctx.ui.setStatus(STATUS, ctx.ui.theme.fg("accent", `${modelLabel} · ${progress.message} · ${usage}`));
}

async function runAbridgement(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	prepared: PreparedDiff,
	taskContext: string,
	config: DiffMeatConfig,
	abridge: DiffMeatExtensionDependencies["abridgeDiff"],
): Promise<AbridgeOutcome> {
	const modelLabel = `${formatModel(config)} (${config.thinkingLevel})`;
	const buildOptions = (signal?: AbortSignal): AbridgeDiffOptions => ({
		repoRoot: prepared.repoRoot,
		taskContext,
		config,
		signal,
		onProgress: (progress) => progressStatus(ctx, modelLabel, progress),
	});
	if (ctx.mode !== "tui") {
		return { status: "completed", reading: await abridge(pi, ctx, prepared.rawPatch, buildOptions()) };
	}

	return await ctx.ui.custom<AbridgeOutcome>((tui, theme, _keybindings, done) => {
		const loader = new BorderedLoader(tui, theme, `Abridging diff with ${modelLabel}...`);
		let settled = false;
		const finish = (outcome: AbridgeOutcome) => {
			if (settled) return;
			settled = true;
			done(outcome);
		};
		loader.onAbort = () => finish({ status: "cancelled" });
		void abridge(pi, ctx, prepared.rawPatch, buildOptions(loader.signal))
			.then((reading) => finish({ status: "completed", reading }))
			.catch((error) => {
				if (loader.signal.aborted) finish({ status: "cancelled" });
				else finish({ status: "failed", error });
			});
		return loader;
	});
}

export function createDiffMeatExtension(overrides: Partial<DiffMeatExtensionDependencies> = {}) {
	const dependencies = { ...createDefaultDependencies(), ...overrides } satisfies DiffMeatExtensionDependencies;

	return function (pi: ExtensionAPI) {
		const openReview = async (ctx: ExtensionContext, prepared: PreparedDiff, reading: ReadingDiff) => {
			try {
				const plannotatorCtx = await dependencies.preparePlannotatorContext(ctx);
				const result = await dependencies.openReadingDiffReview(plannotatorCtx, prepared.repoRoot, prepared, reading);
				await handlePlannotatorDecision(pi, ctx, result, {
					delivery: "steer",
					notifications: {
						approved: "Reading diff approved.",
						closed: "Reading diff review closed.",
						empty: "Reading diff review closed without feedback.",
						sent: "Sent reading diff feedback to the agent.",
					},
				});
			} catch (error) {
				notify(ctx, error instanceof Error ? error.message : "Failed to open the reading diff.", "error");
			}
		};
		const prepareReview = async (args: string, ctx: ExtensionContext) => {
			try {
				if (!(await dependencies.isGitRepository(pi, ctx.cwd))) {
					notify(ctx, "This command only works inside a git repository.", "error");
					return;
				}

				const target = await dependencies.resolveDiffTargetFromArgs(pi, ctx, args);
				if (!target) return;

				const config = dependencies.loadConfig();
				const prepared = await dependencies.prepareDiff(pi, ctx.cwd, target);
				const taskContext = await dependencies.buildDiffContext(pi, ctx, prepared.repoRoot, target);
				const outcome = await runAbridgement(pi, ctx, prepared, taskContext, config, dependencies.abridgeDiff);
				ctx.ui.setStatus(STATUS, undefined);
				if (outcome.status === "cancelled") {
					notify(ctx, "Diff abridgement cancelled.", "info");
					return;
				}
				if (outcome.status === "failed") throw outcome.error;
				const reading = outcome.reading;
				if (!reading.rawPatch.trim()) {
					notify(ctx, reading.summary || "No review-worthy changes remained after abridging.", "info");
					return;
				}

				const retention = reading.totalSections === 0 ? 0 : Math.round(reading.keptSections / reading.totalSections * 100);
				const usage = `${reading.usage.input.toLocaleString()} input / ${reading.usage.output.toLocaleString()} output tokens`;
				notify(
					ctx,
					reading.fromCache
						? `Reading diff loaded from cache · ${reading.keptSections}/${reading.totalSections} sections (${retention}%).`
						: `Reading diff keeps ${reading.keptSections}/${reading.totalSections} sections (${retention}%) · ${usage}.`,
					"info",
				);
				void openReview(ctx, prepared, reading);
			} catch (error) {
				ctx.ui.setStatus(STATUS, undefined);
				notify(ctx, error instanceof Error ? error.message : "Failed to prepare the reading diff.", "error");
			}
		};

		registerPlannotatorFeedbackRenderer(pi);
		pi.registerCommand(COMMAND, {
			description: "Abridge a diff into a source-anchored reading diff and review it in Plannotator",
			handler: async (args, ctx) => {
				if (!ctx.hasUI) return;
				await prepareReview(args, ctx);
			},
		});
	};
}

export default createDiffMeatExtension();
