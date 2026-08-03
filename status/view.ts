import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type PullRequestViewData = {
	url: string;
	state: string | null;
};

export type StatusHeaderPayload = {
	repoLabel: string;
	sessionName: string | null;
	pullRequest: PullRequestViewData | null;
};

export type StatusDetailsPayload = {
	modelLabel: string;
	thinkingLevel: string;
	openAIParamsLabel?: string;
	contextLabel: string;
	contextUsage: number | null;
	agentMinutesLabel: string;
	turnTotalMinutesLabel: string;
	sessionMinutesLabel: string;
};

export function renderStatusHeader(payload: StatusHeaderPayload, theme: Theme, width: number): string[] {
	const repoLabel = theme.fg("dim", payload.repoLabel);
	const sessionLabel = payload.sessionName ? `${theme.fg("accent", payload.sessionName)} ${theme.fg("dim", "·")} ` : "";
	const lines = [padLine(`${sessionLabel}${repoLabel}`, width, 1)];
	if (payload.pullRequest) {
		const stateLabel = payload.pullRequest.state && payload.pullRequest.state !== "OPEN"
			? ` (${payload.pullRequest.state.toLowerCase()})`
			: "";
		const prLine = `${theme.fg("dim", "PR:")} ${theme.fg("accent", payload.pullRequest.url)}${theme.fg("dim", stateLabel)}`;
		lines.push(padLine(prLine, width, 1));
	}
	return lines;
}

export function renderStatusDetails(payload: StatusDetailsPayload, theme: Theme, width: number): string[] {
	const modelLabel = theme.fg("muted", payload.modelLabel);
	const thinkingLevelLabel = theme.fg(resolveThinkingColor(payload.thinkingLevel), payload.thinkingLevel);
	const openAIParamsLabel = payload.openAIParamsLabel ? ` ${theme.fg("muted", payload.openAIParamsLabel)}` : "";
	const thinkingLabel = `${theme.fg("muted", "(")}${thinkingLevelLabel}${openAIParamsLabel}${theme.fg("muted", ")")}`;
	const contextLabel = theme.fg(resolveContextColor(payload.contextUsage), payload.contextLabel);
	const left = [modelLabel, thinkingLabel, contextLabel].join(" ");
	const right = theme.fg(
		"muted",
		`${payload.agentMinutesLabel} agent · ${payload.turnTotalMinutesLabel} turn total · ${payload.sessionMinutesLabel} session`,
	);
	return [renderAlignedLine(left, right, width, 1)];
}

export const createStatusHeaderWidget = (payload: StatusHeaderPayload) => (_tui: unknown, theme: Theme) => ({
	render: (width: number) => renderStatusHeader(payload, theme, width),
	invalidate: () => {},
});

export const createStatusDetailsWidget = (payload: StatusDetailsPayload) => (_tui: unknown, theme: Theme) => ({
	render: (width: number) => renderStatusDetails(payload, theme, width),
	invalidate: () => {},
});

function resolveThinkingColor(level: string): ThemeColor {
	switch (level) {
		case "minimal":
			return "thinkingMinimal";
		case "low":
			return "thinkingLow";
		case "medium":
			return "thinkingMedium";
		case "high":
			return "thinkingHigh";
		case "xhigh":
			return "thinkingXhigh";
		case "max":
			return "thinkingMax";
		default:
			return "thinkingOff";
	}
}

function resolveContextColor(percent: number | null): ThemeColor {
	if (percent === null || Number.isNaN(percent)) {
		return "muted";
	}
	if (percent >= 90) {
		return "error";
	}
	if (percent >= 60) {
		return "warning";
	}
	return "muted";
}

function renderAlignedLine(left: string, right: string, width: number, padding: number): string {
	const safePadding = Math.max(0, padding);
	const availableWidth = Math.max(0, width - safePadding * 2);
	const leftWidth = visibleWidth(left);
	if (leftWidth >= availableWidth) {
		return padLine(truncateToWidth(left, availableWidth), width, safePadding);
	}

	const rightWidth = visibleWidth(right);
	const gap = availableWidth - leftWidth - rightWidth;
	if (gap >= 1) {
		const line = left + " ".repeat(gap) + right;
		return padLine(line, width, safePadding);
	}

	const rightMax = Math.max(0, availableWidth - leftWidth - 1);
	if (rightMax <= 0) {
		return padLine(left, width, safePadding);
	}

	const truncatedRight = truncateToWidth(right, rightMax);
	return padLine(left + " " + truncatedRight, width, safePadding);
}

function padLine(line: string, width: number, padding: number): string {
	const pad = Math.max(0, padding);
	const innerWidth = Math.max(0, width - pad * 2);
	const trimmed = truncateToWidth(line, innerWidth);
	return " ".repeat(pad) + trimmed + " ".repeat(Math.max(0, width - pad - visibleWidth(trimmed)));
}
