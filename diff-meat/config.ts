export type RetentionLevel = "light" | "balanced" | "aggressive";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type DiffMeatConfig = {
	modelProvider: string;
	modelId: string;
	thinkingLevel: ThinkingLevel;
	maxChunkTokens: number;
	retention: RetentionLevel;
	sourceInspection: boolean;
	cache: boolean;
};

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const RETENTION_LEVELS = new Set<RetentionLevel>(["light", "balanced", "aggressive"]);

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
	if (value === undefined) return fallback;
	return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

function parseModel(value: string | undefined): { provider: string; id: string } {
	const normalized = value?.trim() || "openai-codex/gpt-5.6-luna";
	const separator = normalized.indexOf("/");
	if (separator <= 0 || separator === normalized.length - 1) {
		throw new Error("DIFF_MEAT_MODEL must use provider/model format.");
	}
	return { provider: normalized.slice(0, separator), id: normalized.slice(separator + 1) };
}

export function loadDiffMeatConfig(env: NodeJS.ProcessEnv = process.env): DiffMeatConfig {
	const model = parseModel(env.DIFF_MEAT_MODEL);
	const thinking = (env.DIFF_MEAT_THINKING?.trim().toLowerCase() || "high") as ThinkingLevel;
	if (!THINKING_LEVELS.has(thinking)) {
		throw new Error(`Invalid DIFF_MEAT_THINKING: ${thinking}`);
	}
	const retention = (env.DIFF_MEAT_RETENTION?.trim().toLowerCase() || "balanced") as RetentionLevel;
	if (!RETENTION_LEVELS.has(retention)) {
		throw new Error(`Invalid DIFF_MEAT_RETENTION: ${retention}`);
	}
	const rawChunkTokens = env.DIFF_MEAT_MAX_CHUNK_TOKENS?.trim();
	const maxChunkTokens = rawChunkTokens ? Number.parseInt(rawChunkTokens, 10) : 120_000;
	if (!Number.isInteger(maxChunkTokens) || maxChunkTokens < 8_000 || maxChunkTokens > 500_000) {
		throw new Error("DIFF_MEAT_MAX_CHUNK_TOKENS must be an integer between 8000 and 500000.");
	}
	return {
		modelProvider: model.provider,
		modelId: model.id,
		thinkingLevel: thinking,
		maxChunkTokens,
		retention,
		sourceInspection: parseBoolean(env.DIFF_MEAT_SOURCE_INSPECTION, true),
		cache: parseBoolean(env.DIFF_MEAT_CACHE, true),
	};
}

export function formatModel(config: DiffMeatConfig): string {
	return `${config.modelProvider}/${config.modelId}`;
}
