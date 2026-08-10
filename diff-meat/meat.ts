import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildCacheKey, readCachedReadingDiff, writeCachedReadingDiff } from "./cache";
import { loadDiffMeatConfig, type DiffMeatConfig } from "./config";
import { createReadingDiffPlan, type PlannerProgress } from "./planner";
import type { ReadingDiff } from "./types";

const PROTOCOL_VERSION = "source-edit-plan-v2";

export type AbridgeDiffOptions = {
	repoRoot?: string;
	taskContext?: string;
	config?: DiffMeatConfig;
	signal?: AbortSignal;
	onProgress?: (progress: PlannerProgress) => void;
};

export async function abridgeDiff(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	rawPatch: string,
	options: AbridgeDiffOptions = {},
): Promise<ReadingDiff> {
	const config = options.config ?? loadDiffMeatConfig();
	const repoRoot = options.repoRoot ?? ctx.cwd;
	const sourceInspection = config.sourceInspection && ctx.isProjectTrusted();
	let sourceFingerprint = "";
	if (config.cache && sourceInspection) {
		const head = await pi.exec("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
		sourceFingerprint = `${repoRoot}:${head.code === 0 ? head.stdout.trim() : "unborn"}`;
	}
	const cacheKey = buildCacheKey([
		PROTOCOL_VERSION,
		rawPatch,
		options.taskContext ?? "",
		config.modelProvider,
		config.modelId,
		config.thinkingLevel,
		config.maxChunkTokens,
		config.retention,
		sourceInspection,
		sourceFingerprint,
	]);
	if (config.cache) {
		const cached = await readCachedReadingDiff(cacheKey);
		if (cached) {
			return { ...cached, fromCache: true };
		}
	}

	const result = await createReadingDiffPlan({
		pi,
		ctx,
		rawPatch,
		repoRoot,
		taskContext: options.taskContext ?? "",
		config,
		signal: options.signal,
		onProgress: options.onProgress,
	});
	const reading: ReadingDiff = {
		rawPatch: result.rawPatch,
		summary: result.summary,
		keptSections: result.keptSections,
		totalSections: result.totalSections,
		usage: result.usage,
		fromCache: false,
	};
	if (config.cache) await writeCachedReadingDiff(cacheKey, reading);
	return reading;
}
