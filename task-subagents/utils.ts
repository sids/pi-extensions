import {
	SUBAGENT_CONTEXT_MODES,
	SUBAGENT_THINKING_LEVELS,
	SUBAGENT_TOOL_THINKING_LEVELS,
	type SubagentContextMode,
	type SubagentThinkingLevel,
} from "./types";

export function resolveSubagentConcurrency(value: number | undefined): number | null {
	const concurrency = value ?? 2;
	if (!Number.isFinite(concurrency) || !Number.isInteger(concurrency)) {
		return null;
	}
	if (concurrency < 1 || concurrency > 4) {
		return null;
	}
	return concurrency;
}

export function resolveSubagentThinkingLevel(value: unknown): SubagentThinkingLevel | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const normalized = value.trim().toLowerCase();
	return SUBAGENT_THINKING_LEVELS.includes(normalized as SubagentThinkingLevel)
		? (normalized as SubagentThinkingLevel)
		: undefined;
}

export function resolveSubagentToolThinkingLevel(
	value: unknown,
	fallback: SubagentThinkingLevel | undefined,
): SubagentThinkingLevel | null {
	if (value === undefined) {
		return fallback;
	}
	const normalized = resolveSubagentThinkingLevel(value);
	if (!normalized || !SUBAGENT_TOOL_THINKING_LEVELS.includes(normalized as (typeof SUBAGENT_TOOL_THINKING_LEVELS)[number])) {
		return null;
	}
	return normalized;
}

export function resolveSubagentContextMode(value: unknown): SubagentContextMode | null {
	if (value === undefined) {
		return "fresh";
	}
	if (typeof value !== "string") {
		return null;
	}
	const normalized = value.trim().toLowerCase();
	return SUBAGENT_CONTEXT_MODES.includes(normalized as SubagentContextMode)
		? (normalized as SubagentContextMode)
		: null;
}
