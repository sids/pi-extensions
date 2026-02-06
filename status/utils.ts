import os from "node:os";
import path from "node:path";

export const UNKNOWN_VALUE = "--";

export type ModelLabelInput = {
	provider?: string;
	id?: string;
};

export function formatModelLabel(model?: ModelLabelInput | null): string {
	if (!model?.provider || !model?.id) {
		return "none";
	}
	return `${model.provider}/${model.id}`;
}

export function formatThinkingLevel(level?: string): string {
	return level?.trim() ? level : "off";
}

export function formatWorkingDirectory(cwd: string): string {
	const home = os.homedir();
	if (cwd === home) {
		return "~";
	}
	const prefix = home + path.sep;
	if (cwd.startsWith(prefix)) {
		return `~${cwd.slice(home.length)}`;
	}
	return cwd;
}

export function formatContextPercent(usage?: { percent: number } | null): string {
	if (!usage || Number.isNaN(usage.percent)) {
		return UNKNOWN_VALUE;
	}
	return `${Math.round(usage.percent)}%`;
}

export function formatLoopMinutes(minutes?: number | null): string {
	if (minutes === null || minutes === undefined || Number.isNaN(minutes) || minutes < 0) {
		return UNKNOWN_VALUE;
	}
	return `${Math.floor(minutes)}min`;
}

export function normalizeGitBranch(branch?: string | null): string {
	const trimmed = branch?.trim();
	if (!trimmed) {
		return UNKNOWN_VALUE;
	}
	return trimmed;
}

export function formatRepoLabel(cwd: string, branch?: string | null): string {
	const dir = formatWorkingDirectory(cwd);
	const gitBranch = normalizeGitBranch(branch);
	return `${dir} (${gitBranch})`;
}
