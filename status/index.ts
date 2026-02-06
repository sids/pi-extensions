import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import {
	formatContextPercent,
	formatLoopMinutes,
	formatModelLabel,
	formatRepoLabel,
	formatThinkingLevel,
} from "./utils";

const STATUS_WIDGET_KEY = "status";
const RUNNING_EMOJI = "♨️";
const DONE_EMOJI = "✅";

type StatusPayload = {
	modelLabel: string;
	thinkingLevel: string;
	contextPercent: string;
	contextUsage: number | null;
	repoLabel: string;
	loopMinutesLabel: string;
};

const createStatusWidget = (payload: StatusPayload) => (_tui: unknown, theme: { fg: (name: string, text: string) => string }) => ({
	render: (width: number) => {
		const modelLabel = theme.fg("muted", payload.modelLabel);
		const thinkingLabel = theme.fg(resolveThinkingColor(payload.thinkingLevel), `(${payload.thinkingLevel})`);
		const contextLabel = theme.fg(resolveContextColor(payload.contextUsage), payload.contextPercent);
		const loopMinutesLabel = theme.fg("muted", payload.loopMinutesLabel);
		const repoLabel = theme.fg("muted", payload.repoLabel);
		const right = `${modelLabel} ${thinkingLabel} ${contextLabel} ${loopMinutesLabel}`;

		return [renderAlignedLine(repoLabel, right, width, 1)];
	},
	invalidate: () => {},
});

const createEmptyFooter = () => (_tui: unknown, _theme: unknown, _footerData: unknown) => ({
	render: () => [],
	invalidate: () => {},
});

function resolveThinkingColor(level: string): string {
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
		default:
			return "thinkingOff";
	}
}

function resolveContextColor(percent: number | null): string {
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
	const rightWidth = visibleWidth(right);
	if (rightWidth >= availableWidth) {
		return padLine(truncateToWidth(right, availableWidth), width, safePadding);
	}

	const leftWidth = visibleWidth(left);
	const gap = availableWidth - leftWidth - rightWidth;
	if (gap >= 1) {
		const line = left + " ".repeat(gap) + right;
		return padLine(line, width, safePadding);
	}

	const leftMax = Math.max(0, availableWidth - rightWidth - 1);
	if (leftMax <= 0) {
		return padLine(truncateToWidth(right, availableWidth), width, safePadding);
	}

	const truncatedLeft = truncateToWidth(left, leftMax);
	return padLine(truncatedLeft + " " + right, width, safePadding);
}

function padLine(line: string, width: number, padding: number): string {
	const pad = Math.max(0, padding);
	const innerWidth = Math.max(0, width - pad * 2);
	const trimmed = truncateToWidth(line, innerWidth);
	return " ".repeat(pad) + trimmed + " ".repeat(Math.max(0, width - pad - visibleWidth(trimmed)));
}

function getBaseTitle(cwd: string, sessionName?: string): string {
	const dir = path.basename(cwd);
	return sessionName ? `π - ${sessionName} - ${dir}` : `π - ${dir}`;
}

async function resolveGitBranch(pi: ExtensionAPI, cwd: string): Promise<string | null> {
	try {
		const result = await pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeout: 1500 });
		if (result.code !== 0) {
			return null;
		}
		const branch = result.stdout.trim();
		if (!branch) {
			return null;
		}
		if (branch === "HEAD") {
			return "detached";
		}
		return branch;
	} catch {
		return null;
	}
}

export default function (pi: ExtensionAPI) {
	let lastSignature = "";
	let updateToken = 0;
	let isRunning = false;
	let isTyping = false;
	let suppressDoneEmoji = false;
	let lastTitle = "";
	let typingTimer: ReturnType<typeof setInterval> | null = null;
	let activeContext: ExtensionContext | null = null;
	let lastThinkingLevel = "";
	let enabled = true;
	let activeLoopStartedAt: number | null = null;
	let lastLoopMinutes: number | null = null;

	const getLoopMinutes = (): number | null => {
		if (activeLoopStartedAt === null) {
			return lastLoopMinutes;
		}
		return Math.max(0, Math.floor((Date.now() - activeLoopStartedAt) / 60_000));
	};

	const updateLoopMinutes = (ctx: ExtensionContext) => {
		if (!isRunning || activeLoopStartedAt === null) {
			return;
		}
		const elapsedMinutes = getLoopMinutes();
		if (elapsedMinutes === null || elapsedMinutes === lastLoopMinutes) {
			return;
		}
		lastLoopMinutes = elapsedMinutes;
		void updateWidget(ctx);
	};

	const refreshTitle = (ctx: ExtensionContext) => {
		if (!ctx.hasUI || !enabled) {
			return;
		}
		const baseTitle = getBaseTitle(ctx.cwd, pi.getSessionName());
		let title = baseTitle;
		if (isRunning) {
			title = `${baseTitle} ${RUNNING_EMOJI}`;
		} else if (!suppressDoneEmoji && !isTyping) {
			title = `${baseTitle} ${DONE_EMOJI}`;
		}
		if (title === lastTitle) {
			return;
		}
		lastTitle = title;
		ctx.ui.setTitle(title);
	};

	const updateTypingState = (ctx: ExtensionContext) => {
		if (!ctx.hasUI || !enabled) {
			return;
		}
		const hasText = ctx.ui.getEditorText().length > 0;
		if (hasText === isTyping) {
			return;
		}
		isTyping = hasText;
		if (hasText) {
			suppressDoneEmoji = true;
		}
		refreshTitle(ctx);
	};

	const updateThinkingLevel = (ctx: ExtensionContext) => {
		const current = formatThinkingLevel(pi.getThinkingLevel());
		if (current === lastThinkingLevel) {
			return;
		}
		lastThinkingLevel = current;
		void updateWidget(ctx);
	};

	const startTypingWatcher = (ctx: ExtensionContext) => {
		if (!ctx.hasUI || !enabled) {
			return;
		}
		activeContext = ctx;
		if (typingTimer) {
			clearInterval(typingTimer);
		}
		typingTimer = setInterval(() => {
			if (!activeContext || !activeContext.hasUI || !enabled) {
				return;
			}
			updateTypingState(activeContext);
			updateThinkingLevel(activeContext);
			updateLoopMinutes(activeContext);
		}, 200);
		updateTypingState(ctx);
		updateThinkingLevel(ctx);
		updateLoopMinutes(ctx);
	};

	const stopTypingWatcher = () => {
		if (typingTimer) {
			clearInterval(typingTimer);
			typingTimer = null;
		}
	};

	const disableDefaultFooter = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) {
			return;
		}
		ctx.ui.setFooter(createEmptyFooter());
	};

	const updateWidget = async (ctx: ExtensionContext) => {
		if (!ctx.hasUI || !enabled) {
			return;
		}
		const token = ++updateToken;
		const branch = await resolveGitBranch(pi, ctx.cwd);
		if (token !== updateToken) {
			return;
		}

		const usage = ctx.getContextUsage();
		const payload: StatusPayload = {
			modelLabel: formatModelLabel(ctx.model),
			thinkingLevel: formatThinkingLevel(pi.getThinkingLevel()),
			contextPercent: formatContextPercent(usage),
			contextUsage: usage?.percent ?? null,
			repoLabel: formatRepoLabel(ctx.cwd, branch),
			loopMinutesLabel: formatLoopMinutes(getLoopMinutes()),
		};

		const signature = JSON.stringify(payload);
		if (signature === lastSignature) {
			return;
		}
		lastSignature = signature;
		ctx.ui.setWidget(STATUS_WIDGET_KEY, createStatusWidget(payload), { placement: "belowEditor" });
	};

	const applyEnabledState = async (ctx: ExtensionContext) => {
		if (!ctx.hasUI) {
			return;
		}
		if (enabled) {
			lastSignature = "";
			lastThinkingLevel = formatThinkingLevel(pi.getThinkingLevel());
			disableDefaultFooter(ctx);
			startTypingWatcher(ctx);
			await updateWidget(ctx);
			refreshTitle(ctx);
		} else {
			ctx.ui.setWidget(STATUS_WIDGET_KEY, undefined, { placement: "belowEditor" });
			ctx.ui.setFooter(undefined);
			stopTypingWatcher();
			lastSignature = "";
			lastThinkingLevel = "";
			lastTitle = "";
			ctx.ui.setTitle(getBaseTitle(ctx.cwd, pi.getSessionName()));
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		isRunning = false;
		activeLoopStartedAt = null;
		lastLoopMinutes = null;
		suppressDoneEmoji = false;
		await applyEnabledState(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		isRunning = false;
		activeLoopStartedAt = null;
		lastLoopMinutes = null;
		suppressDoneEmoji = false;
		await applyEnabledState(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		if (!enabled) {
			return;
		}
		await updateWidget(ctx);
	});

	pi.on("input", async (_event, ctx) => {
		updateTypingState(ctx);
		await updateWidget(ctx);
	});

	pi.on("user_bash", async (_event, ctx) => {
		await updateWidget(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		isRunning = true;
		activeLoopStartedAt = Date.now();
		lastLoopMinutes = 0;
		suppressDoneEmoji = false;
		refreshTitle(ctx);
		await updateWidget(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		await updateWidget(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (activeLoopStartedAt !== null) {
			lastLoopMinutes = Math.max(0, Math.floor((Date.now() - activeLoopStartedAt) / 60_000));
			activeLoopStartedAt = null;
		}
		isRunning = false;
		refreshTitle(ctx);
		await updateWidget(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (activeLoopStartedAt !== null) {
			lastLoopMinutes = Math.max(0, Math.floor((Date.now() - activeLoopStartedAt) / 60_000));
			activeLoopStartedAt = null;
		}
		isRunning = false;
		stopTypingWatcher();
		refreshTitle(ctx);
	});

	pi.registerCommand("custom-status", {
		description: "Toggle custom status widget and title behavior",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			if (!ctx.hasUI) {
				return;
			}
			if (enabled) {
				suppressDoneEmoji = false;
				isTyping = false;
				await applyEnabledState(ctx);
				ctx.ui.notify("Custom status enabled", "info");
				return;
			}
			await applyEnabledState(ctx);
			ctx.ui.notify("Custom status disabled", "info");
		},
	});
}
