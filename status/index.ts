import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import {
	activeAgentDurationMs,
	applyTitleAttention,
	carryForwardTimingDurations,
	clearTitleAttention,
	elapsedDurationMs,
	filterPullRequestsByHeadOwner,
	formatContextPercent,
	formatElapsedMinutes,
	formatModelLabel,
	formatPullRequestLabel,
	formatRepoLabel,
	formatThinkingLevel,
	isGitHubHost,
	parseAllowedGitHubHosts,
	parseGitRemoteRepo,
	pickPullRequest,
	shouldPromoteLongRunningToolWarning,
	type GitRemoteRepo,
	type PullRequestSummary,
} from "./utils";

const STATUS_WIDGET_KEY = "status";
const TITLE_WARNING_PREFIX = "⚠️";
const TITLE_DONE_PREFIX = "✔";
const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TITLE_SPINNER_INTERVAL_MS = 80;
const EDITOR_ACTIVITY_POLL_INTERVAL_MS = 250;
const LONG_RUNNING_TITLE_THRESHOLD_MS = 10_000;
const TITLE_ATTENTION_EVENT_CHANNEL = "status:title_attention";
const REMOTE_REPO_CACHE_TTL_MS = 30_000;
const PR_CACHE_TTL_MS = 30_000;
const PR_POLL_INTERVAL_MS = 30_000;

type StatusPayload = {
	modelLabel: string;
	thinkingLevel: string;
	contextPercent: string;
	contextUsage: number | null;
	repoLabel: string;
	loopMinutesLabel: string;
	agentMinutesLabel: string;
	sessionMinutesLabel: string;
	pullRequestLabel: string | null;
};

type WidgetUpdateOptions = {
	forcePrRefresh?: boolean;
	forceRepoRefresh?: boolean;
	skipPullRequestLookup?: boolean;
};

type TitleAttentionEvent = {
	id: string;
	active: boolean;
};

function parseTitleAttentionEvent(data: unknown): TitleAttentionEvent | null {
	if (!data || typeof data !== "object") {
		return null;
	}

	const value = data as { id?: unknown; active?: unknown };
	if (typeof value.id !== "string" || value.id.trim().length === 0) {
		return null;
	}
	if (typeof value.active !== "boolean") {
		return null;
	}

	return {
		id: value.id,
		active: value.active,
	};
}

const createStatusWidget = (payload: StatusPayload) => (_tui: unknown, theme: { fg: (name: string, text: string) => string }) => ({
	render: (width: number) => {
		const modelLabel = theme.fg("muted", payload.modelLabel);
		const thinkingLabel = theme.fg(resolveThinkingColor(payload.thinkingLevel), `(${payload.thinkingLevel})`);
		const contextLabel = theme.fg(resolveContextColor(payload.contextUsage), payload.contextPercent);
		const timingLabel = theme.fg(
			"muted",
			`· ${payload.loopMinutesLabel} loop · ${payload.agentMinutesLabel} agent · ${payload.sessionMinutesLabel} session`,
		);
		const repoLabel = theme.fg("muted", payload.repoLabel);
		const right = `${modelLabel} ${thinkingLabel} ${contextLabel} ${timingLabel}`;
		const lines = [renderAlignedLine(repoLabel, right, width, 1)];
		if (payload.pullRequestLabel) {
			const prContent = payload.pullRequestLabel.replace(/^PR:\s*/, "").trim();
			const prMatch = prContent.match(/^(\S+)(.*)$/);
			const prPrefix = theme.fg("muted", "PR:");
			const prLine = prMatch
				? `${prPrefix} ${theme.fg("accent", prMatch[1])}${prMatch[2] ? theme.fg("muted", prMatch[2]) : ""}`
				: `${prPrefix} ${theme.fg("accent", prContent)}`;
			lines.push(padLine(truncateToWidth(prLine, Math.max(0, width - 2)), width, 1));
		}
		return lines;
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

type RemoteRepoCacheEntry = {
	checkedAt: number;
	repo: GitRemoteRepo | null;
};

async function resolveGitRemoteRepo(
	pi: ExtensionAPI,
	cwd: string,
	cache: Map<string, RemoteRepoCacheEntry>,
	inFlight: Map<string, Promise<GitRemoteRepo | null>>,
	forceRefresh: boolean,
): Promise<GitRemoteRepo | null> {
	const now = Date.now();
	const cached = cache.get(cwd);
	if (!forceRefresh && cached && now - cached.checkedAt < REMOTE_REPO_CACHE_TTL_MS) {
		return cached.repo;
	}

	const pending = inFlight.get(cwd);
	if (pending) {
		return pending;
	}

	const request = (async () => {
		const checkedAt = Date.now();
		try {
			const result = await pi.exec("git", ["config", "--get", "remote.origin.url"], { cwd, timeout: 1500 });
			if (result.code !== 0) {
				cache.set(cwd, { checkedAt, repo: null });
				return null;
			}
			const repo = parseGitRemoteRepo(result.stdout);
			cache.set(cwd, { checkedAt, repo });
			return repo;
		} catch {
			cache.set(cwd, { checkedAt, repo: null });
			return null;
		}
	})();

	inFlight.set(cwd, request);
	try {
		return await request;
	} finally {
		inFlight.delete(cwd);
	}
}

type PullRequestCacheEntry = {
	checkedAt: number;
	pr: PullRequestSummary | null;
};

function getCachedPullRequest(
	repo: GitRemoteRepo | null,
	branch: string | null,
	cache: Map<string, PullRequestCacheEntry>,
): PullRequestSummary | null {
	if (!repo || !branch || branch === "detached") {
		return null;
	}
	const cacheKey = `${repo.repoSelector}:${branch}`;
	return cache.get(cacheKey)?.pr ?? null;
}

async function resolveGitPullRequest(
	pi: ExtensionAPI,
	cwd: string,
	repo: GitRemoteRepo | null,
	branch: string | null,
	cache: Map<string, PullRequestCacheEntry>,
	inFlight: Map<string, Promise<PullRequestSummary | null>>,
	allowedGitHubHosts: ReadonlySet<string>,
	forceRefresh: boolean,
): Promise<PullRequestSummary | null> {
	if (!repo || !branch || branch === "detached") {
		return null;
	}
	if (!isGitHubHost(repo.host, allowedGitHubHosts)) {
		return null;
	}

	const cacheKey = `${repo.repoSelector}:${branch}`;
	const now = Date.now();
	const cached = cache.get(cacheKey);
	if (!forceRefresh && cached && now - cached.checkedAt < PR_CACHE_TTL_MS) {
		return cached.pr;
	}

	const pending = inFlight.get(cacheKey);
	if (pending) {
		return pending;
	}

	const request = (async () => {
		const checkedAt = Date.now();
		try {
			const result = await pi.exec(
				"gh",
				[
					"pr",
					"list",
					"--repo",
					repo.repoSelector,
					"--state",
					"all",
					"--head",
					branch,
					"--limit",
					"20",
					"--json",
					"url,state,updatedAt,headRefName,headRepositoryOwner",
				],
				{ cwd, timeout: 2500 },
			);
			if (result.code !== 0) {
				cache.set(cacheKey, { checkedAt, pr: null });
				return null;
			}
			const parsed = JSON.parse(result.stdout) as PullRequestSummary[];
			const scoped = filterPullRequestsByHeadOwner(Array.isArray(parsed) ? parsed : [], branch, repo.owner);
			const pr = pickPullRequest(scoped);
			cache.set(cacheKey, { checkedAt, pr });
			return pr;
		} catch {
			cache.set(cacheKey, { checkedAt, pr: null });
			return null;
		}
	})();

	inFlight.set(cacheKey, request);
	try {
		return await request;
	} finally {
		inFlight.delete(cacheKey);
	}
}

export default function (pi: ExtensionAPI) {
	let lastSignature = "";
	let updateToken = 0;
	let isRunning = false;
	let hasFailureAttention = false;
	let hasCompletedRun = false;
	let longRunningToolCallIds = new Set<string>();
	let externalAttentionIds = new Set<string>();
	let longRunningToolTimers = new Map<string, ReturnType<typeof setTimeout>>();
	let lastTitle = "";
	let titleSpinnerTimer: ReturnType<typeof setInterval> | null = null;
	let titleFrameIndex = 0;
	let typingTimer: ReturnType<typeof setInterval> | null = null;
	let lastEditorText = "";
	let activeContext: ExtensionContext | null = null;
	let lastThinkingLevel = "";
	let enabled = true;
	let sessionStartedAt: number | null = Date.now();
	let activeLoopStartedAt: number | null = null;
	let lastLoopDurationMs: number | null = null;
	let activeTurnStartedAt: number | null = null;
	let completedTurnDurationMs = 0;
	let carriedSessionDurationMs = 0;
	let carriedAgentDurationMs = 0;
	let lastTimingSignature = "";
	const allowedGitHubHosts = parseAllowedGitHubHosts(process.env.PI_STATUS_ALLOWED_GITHUB_HOSTS);
	let remoteRepoCache = new Map<string, RemoteRepoCacheEntry>();
	let remoteRepoRequestsInFlight = new Map<string, Promise<GitRemoteRepo | null>>();
	let prCache = new Map<string, PullRequestCacheEntry>();
	let prRequestsInFlight = new Map<string, Promise<PullRequestSummary | null>>();
	let lastPeriodicPrRefreshAt = 0;
	let pendingWidgetUpdateCtx: ExtensionContext | null = null;
	let pendingWidgetUpdateOptions: WidgetUpdateOptions | null = null;
	let widgetUpdateRunner: Promise<void> | null = null;

	const resetTimingState = (now = Date.now(), preserveTotals = false) => {
		if (preserveTotals) {
			const carried = carryForwardTimingDurations(
				carriedSessionDurationMs,
				carriedAgentDurationMs,
				sessionStartedAt,
				completedTurnDurationMs,
				activeTurnStartedAt,
				now,
			);
			carriedSessionDurationMs = carried.sessionDurationCarryMs;
			carriedAgentDurationMs = carried.agentDurationCarryMs;
		}
		sessionStartedAt = now;
		activeLoopStartedAt = null;
		lastLoopDurationMs = null;
		activeTurnStartedAt = null;
		completedTurnDurationMs = 0;
		lastTimingSignature = "";
	};

	const finalizeActiveLoop = (now = Date.now()): boolean => {
		if (activeLoopStartedAt === null) {
			return false;
		}
		lastLoopDurationMs = Math.max(0, now - activeLoopStartedAt);
		activeLoopStartedAt = null;
		lastTimingSignature = "";
		return true;
	};

	const beginLoop = (now = Date.now()) => {
		if (activeLoopStartedAt !== null) {
			finalizeActiveLoop(now);
		}
		activeLoopStartedAt = now;
		lastLoopDurationMs = 0;
		lastTimingSignature = "";
	};

	const finalizeActiveTurn = (now = Date.now()): boolean => {
		if (activeTurnStartedAt === null) {
			return false;
		}
		const durationMs = Math.max(0, now - activeTurnStartedAt);
		completedTurnDurationMs += durationMs;
		activeTurnStartedAt = null;
		lastTimingSignature = "";
		return true;
	};

	const beginTurn = (now = Date.now()) => {
		if (activeTurnStartedAt !== null) {
			finalizeActiveTurn(now);
		}
		activeTurnStartedAt = now;
		lastTimingSignature = "";
	};

	const getLoopMinutes = (now = Date.now()): number | null => {
		if (activeLoopStartedAt === null) {
			return lastLoopDurationMs === null ? null : lastLoopDurationMs / 60_000;
		}
		return Math.max(0, (now - activeLoopStartedAt) / 60_000);
	};

	const getTimingMinutes = (now = Date.now()): { loop: number | null; agent: number | null; session: number | null } => {
		const loop = getLoopMinutes(now);
		const agentDurationMs =
			carriedAgentDurationMs + activeAgentDurationMs(completedTurnDurationMs, activeTurnStartedAt, now);
		const sessionDurationMs = carriedSessionDurationMs + elapsedDurationMs(sessionStartedAt, now);
		return {
			loop,
			agent: agentDurationMs / 60_000,
			session: sessionDurationMs / 60_000,
		};
	};

	const getTimingSignature = (now = Date.now()): string => {
		const timings = getTimingMinutes(now);
		return `${formatElapsedMinutes(timings.loop)}|${formatElapsedMinutes(timings.agent)}|${formatElapsedMinutes(timings.session)}`;
	};

	const updateTimingMetrics = (ctx: ExtensionContext) => {
		const nextSignature = getTimingSignature();
		if (nextSignature === lastTimingSignature) {
			return;
		}
		lastTimingSignature = nextSignature;
		void requestWidgetUpdate(ctx, { skipPullRequestLookup: true });
	};

	const maybeRefreshPullRequest = (ctx: ExtensionContext) => {
		if (!ctx.hasUI || !enabled) {
			return;
		}
		const now = Date.now();
		if (now - lastPeriodicPrRefreshAt < PR_POLL_INTERVAL_MS) {
			return;
		}
		lastPeriodicPrRefreshAt = now;
		void requestWidgetUpdate(ctx);
	};

	const hasTitleAttention = (): boolean => {
		return hasFailureAttention || longRunningToolCallIds.size > 0 || externalAttentionIds.size > 0;
	};

	const titleWithPrefix = (ctx: ExtensionContext, prefix: string): string => {
		return `${prefix} ${getBaseTitle(ctx.cwd, pi.getSessionName())}`;
	};

	const setTitle = (ctx: ExtensionContext, title: string) => {
		if (title === lastTitle) {
			return;
		}
		lastTitle = title;
		ctx.ui.setTitle(title);
	};

	const stopTitleSpinner = () => {
		if (titleSpinnerTimer) {
			clearInterval(titleSpinnerTimer);
			titleSpinnerTimer = null;
		}
		titleFrameIndex = 0;
	};

	const renderTitleSpinnerFrame = (ctx: ExtensionContext) => {
		const frame = BRAILLE_FRAMES[titleFrameIndex % BRAILLE_FRAMES.length];
		setTitle(ctx, titleWithPrefix(ctx, frame));
		titleFrameIndex++;
	};

	const startTitleSpinner = (ctx: ExtensionContext) => {
		stopTitleSpinner();
		renderTitleSpinnerFrame(ctx);
		titleSpinnerTimer = setInterval(() => {
			if (!activeContext || !activeContext.hasUI || !enabled) {
				return;
			}
			if (!isRunning || hasTitleAttention()) {
				stopTitleSpinner();
				return;
			}
			renderTitleSpinnerFrame(activeContext);
		}, TITLE_SPINNER_INTERVAL_MS);
	};

	const refreshTitle = (ctx: ExtensionContext) => {
		if (!ctx.hasUI || !enabled) {
			return;
		}
		activeContext = ctx;

		if (hasTitleAttention()) {
			stopTitleSpinner();
			setTitle(ctx, titleWithPrefix(ctx, TITLE_WARNING_PREFIX));
			return;
		}

		if (isRunning) {
			if (!titleSpinnerTimer) {
				startTitleSpinner(ctx);
			}
			return;
		}

		stopTitleSpinner();
		if (!hasCompletedRun) {
			setTitle(ctx, getBaseTitle(ctx.cwd, pi.getSessionName()));
			return;
		}
		setTitle(ctx, titleWithPrefix(ctx, TITLE_DONE_PREFIX));
	};

	const shouldTrackLongRunningTool = (toolName: string): boolean => {
		const normalizedName = toolName.trim().toLowerCase();
		if (normalizedName === "bash") {
			return false;
		}
		if (normalizedName.includes("agent")) {
			return false;
		}
		return true;
	};

	const scheduleLongRunningToolWarning = (ctx: ExtensionContext, toolCallId: string) => {
		const existingTimer = longRunningToolTimers.get(toolCallId);
		if (existingTimer) {
			clearTimeout(existingTimer);
		}
		const timer = setTimeout(() => {
			if (!shouldPromoteLongRunningToolWarning(toolCallId, longRunningToolTimers, timer)) {
				return;
			}
			longRunningToolTimers.delete(toolCallId);
			const previousSize = longRunningToolCallIds.size;
			longRunningToolCallIds.add(toolCallId);
			if (longRunningToolCallIds.size !== previousSize) {
				refreshTitle(ctx);
			}
		}, LONG_RUNNING_TITLE_THRESHOLD_MS);
		longRunningToolTimers.set(toolCallId, timer);
	};

	const clearLongRunningToolWarning = (ctx: ExtensionContext, toolCallId: string) => {
		const timer = longRunningToolTimers.get(toolCallId);
		if (timer) {
			clearTimeout(timer);
			longRunningToolTimers.delete(toolCallId);
		}
		if (longRunningToolCallIds.delete(toolCallId)) {
			refreshTitle(ctx);
		}
	};

	const clearToolTitleWarnings = (ctx?: ExtensionContext) => {
		const hadWarnings = longRunningToolCallIds.size > 0;
		for (const timer of longRunningToolTimers.values()) {
			clearTimeout(timer);
		}
		longRunningToolTimers = new Map<string, ReturnType<typeof setTimeout>>();
		longRunningToolCallIds = new Set<string>();
		if (hadWarnings && ctx) {
			refreshTitle(ctx);
		}
	};

	const setFailureAttention = (ctx: ExtensionContext, active: boolean) => {
		if (hasFailureAttention === active) {
			return;
		}
		hasFailureAttention = active;
		refreshTitle(ctx);
	};

	const clearExternalTitleAttention = (ctx?: ExtensionContext) => {
		if (!clearTitleAttention(externalAttentionIds)) {
			return;
		}
		if (ctx) {
			refreshTitle(ctx);
		}
	};

	const removeTitleAttentionListener = pi.events.on(TITLE_ATTENTION_EVENT_CHANNEL, (data) => {
		const event = parseTitleAttentionEvent(data);
		if (!event || !enabled) {
			return;
		}
		if (!applyTitleAttention(externalAttentionIds, event.id, event.active)) {
			return;
		}
		if (activeContext) {
			refreshTitle(activeContext);
		}
	});

	const markEditorActivity = (ctx: ExtensionContext) => {
		if (!enabled || !hasCompletedRun) {
			return;
		}
		hasCompletedRun = false;
		if (!isRunning && !hasTitleAttention()) {
			refreshTitle(ctx);
		}
	};

	const updateEditorActivity = (ctx: ExtensionContext) => {
		if (!ctx.hasUI || !enabled) {
			return;
		}
		const currentText = ctx.ui.getEditorText();
		if (currentText === lastEditorText) {
			return;
		}
		lastEditorText = currentText;
		markEditorActivity(ctx);
	};

	const updateThinkingLevel = (ctx: ExtensionContext) => {
		const current = formatThinkingLevel(pi.getThinkingLevel());
		if (current === lastThinkingLevel) {
			return;
		}
		lastThinkingLevel = current;
		void requestWidgetUpdate(ctx);
	};

	const startTypingWatcher = (ctx: ExtensionContext) => {
		if (!ctx.hasUI || !enabled) {
			return;
		}
		activeContext = ctx;
		lastEditorText = ctx.ui.getEditorText();
		if (typingTimer) {
			clearInterval(typingTimer);
		}
		typingTimer = setInterval(() => {
			if (!activeContext || !activeContext.hasUI || !enabled) {
				return;
			}
			if (hasCompletedRun) {
				updateEditorActivity(activeContext);
			}
			updateThinkingLevel(activeContext);
			updateTimingMetrics(activeContext);
			maybeRefreshPullRequest(activeContext);
		}, EDITOR_ACTIVITY_POLL_INTERVAL_MS);
		updateThinkingLevel(ctx);
		updateTimingMetrics(ctx);
		maybeRefreshPullRequest(ctx);
	};

	const stopTypingWatcher = () => {
		if (typingTimer) {
			clearInterval(typingTimer);
			typingTimer = null;
		}
		lastEditorText = "";
	};

	const disableDefaultFooter = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) {
			return;
		}
		ctx.ui.setFooter(createEmptyFooter());
	};

	const updateWidget = async (ctx: ExtensionContext, options?: WidgetUpdateOptions) => {
		if (!ctx.hasUI || !enabled) {
			return;
		}
		const token = ++updateToken;
		const branch = await resolveGitBranch(pi, ctx.cwd);
		if (token !== updateToken) {
			return;
		}
		const repo = await resolveGitRemoteRepo(
			pi,
			ctx.cwd,
			remoteRepoCache,
			remoteRepoRequestsInFlight,
			options?.forceRepoRefresh ?? false,
		);
		if (token !== updateToken) {
			return;
		}
		const pullRequest = options?.skipPullRequestLookup
			? getCachedPullRequest(repo, branch, prCache)
			: await resolveGitPullRequest(
					pi,
					ctx.cwd,
					repo,
					branch,
					prCache,
					prRequestsInFlight,
					allowedGitHubHosts,
					options?.forcePrRefresh ?? false,
				);
		if (token !== updateToken) {
			return;
		}

		const usage = ctx.getContextUsage();
		const timings = getTimingMinutes();
		const payload: StatusPayload = {
			modelLabel: formatModelLabel(ctx.model),
			thinkingLevel: formatThinkingLevel(pi.getThinkingLevel()),
			contextPercent: formatContextPercent(usage),
			contextUsage: usage?.percent ?? null,
			repoLabel: formatRepoLabel(ctx.cwd, branch),
			loopMinutesLabel: formatElapsedMinutes(timings.loop),
			agentMinutesLabel: formatElapsedMinutes(timings.agent),
			sessionMinutesLabel: formatElapsedMinutes(timings.session),
			pullRequestLabel: formatPullRequestLabel(pullRequest),
		};

		const signature = JSON.stringify(payload);
		if (signature === lastSignature) {
			return;
		}
		lastSignature = signature;
		ctx.ui.setWidget(STATUS_WIDGET_KEY, createStatusWidget(payload), { placement: "belowEditor" });
	};

	const mergeWidgetUpdateOptions = (base: WidgetUpdateOptions | null, next?: WidgetUpdateOptions): WidgetUpdateOptions => {
		if (!base) {
			return { ...next };
		}
		return {
			forcePrRefresh: Boolean(base.forcePrRefresh || next?.forcePrRefresh),
			forceRepoRefresh: Boolean(base.forceRepoRefresh || next?.forceRepoRefresh),
			skipPullRequestLookup: Boolean((base.skipPullRequestLookup ?? false) && (next?.skipPullRequestLookup ?? false)),
		};
	};

	const requestWidgetUpdate = (ctx: ExtensionContext, options?: WidgetUpdateOptions): Promise<void> => {
		pendingWidgetUpdateCtx = ctx;
		pendingWidgetUpdateOptions = mergeWidgetUpdateOptions(pendingWidgetUpdateOptions, options);
		if (widgetUpdateRunner) {
			return widgetUpdateRunner;
		}

		widgetUpdateRunner = (async () => {
			while (pendingWidgetUpdateCtx) {
				const nextCtx = pendingWidgetUpdateCtx;
				const nextOptions = pendingWidgetUpdateOptions ?? {};
				pendingWidgetUpdateCtx = null;
				pendingWidgetUpdateOptions = null;
				if (!nextCtx) {
					continue;
				}
				await updateWidget(nextCtx, nextOptions);
			}
		})().finally(() => {
			widgetUpdateRunner = null;
		});

		return widgetUpdateRunner;
	};

	const applyEnabledState = async (ctx: ExtensionContext) => {
		if (!ctx.hasUI) {
			return;
		}
		if (enabled) {
			clearToolTitleWarnings();
			hasFailureAttention = false;
			stopTitleSpinner();
			lastSignature = "";
			lastTimingSignature = "";
			lastThinkingLevel = formatThinkingLevel(pi.getThinkingLevel());
			remoteRepoCache = new Map<string, RemoteRepoCacheEntry>();
			remoteRepoRequestsInFlight = new Map<string, Promise<GitRemoteRepo | null>>();
			prCache = new Map<string, PullRequestCacheEntry>();
			prRequestsInFlight = new Map<string, Promise<PullRequestSummary | null>>();
			pendingWidgetUpdateCtx = null;
			pendingWidgetUpdateOptions = null;
			lastPeriodicPrRefreshAt = 0;
			disableDefaultFooter(ctx);
			startTypingWatcher(ctx);
			await requestWidgetUpdate(ctx);
			refreshTitle(ctx);
		} else {
			clearToolTitleWarnings();
			hasFailureAttention = false;
			clearExternalTitleAttention();
			stopTitleSpinner();
			ctx.ui.setWidget(STATUS_WIDGET_KEY, undefined, { placement: "belowEditor" });
			ctx.ui.setFooter(undefined);
			stopTypingWatcher();
			remoteRepoCache = new Map<string, RemoteRepoCacheEntry>();
			remoteRepoRequestsInFlight = new Map<string, Promise<GitRemoteRepo | null>>();
			prCache = new Map<string, PullRequestCacheEntry>();
			prRequestsInFlight = new Map<string, Promise<PullRequestSummary | null>>();
			pendingWidgetUpdateCtx = null;
			pendingWidgetUpdateOptions = null;
			lastPeriodicPrRefreshAt = 0;
			lastSignature = "";
			lastTimingSignature = "";
			lastThinkingLevel = "";
			lastTitle = "";
			ctx.ui.setTitle(getBaseTitle(ctx.cwd, pi.getSessionName()));
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		isRunning = false;
		hasFailureAttention = false;
		hasCompletedRun = false;
		resetTimingState(Date.now(), true);
		clearToolTitleWarnings();
		clearExternalTitleAttention();
		await applyEnabledState(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		isRunning = false;
		hasFailureAttention = false;
		hasCompletedRun = false;
		resetTimingState(Date.now(), true);
		clearToolTitleWarnings();
		clearExternalTitleAttention();
		await applyEnabledState(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		if (!enabled) {
			return;
		}
		await requestWidgetUpdate(ctx);
	});

	pi.on("input", async (_event, ctx) => {
		if (ctx.hasUI) {
			lastEditorText = ctx.ui.getEditorText();
		}
		markEditorActivity(ctx);
		await requestWidgetUpdate(ctx, { skipPullRequestLookup: true });
	});

	pi.on("session_compact", async (_event, ctx) => {
		await requestWidgetUpdate(ctx, { skipPullRequestLookup: true });
	});

	pi.on("user_bash", async (_event, ctx) => {
		await requestWidgetUpdate(ctx, { forceRepoRefresh: true });
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		if (!enabled) {
			return;
		}
		if (!shouldTrackLongRunningTool(event.toolName)) {
			return;
		}
		scheduleLongRunningToolWarning(ctx, event.toolCallId);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		if (!enabled) {
			return;
		}
		clearLongRunningToolWarning(ctx, event.toolCallId);
	});

	pi.on("agent_start", async (_event, ctx) => {
		isRunning = true;
		hasFailureAttention = false;
		beginLoop();
		clearToolTitleWarnings();
		refreshTitle(ctx);
		await requestWidgetUpdate(ctx);
	});

	pi.on("turn_start", async (_event, ctx) => {
		beginTurn();
		await requestWidgetUpdate(ctx, { skipPullRequestLookup: true });
	});

	pi.on("turn_end", async (_event, ctx) => {
		finalizeActiveTurn();
		await requestWidgetUpdate(ctx, { skipPullRequestLookup: true });
	});

	pi.on("agent_end", async (event, ctx) => {
		finalizeActiveTurn();
		finalizeActiveLoop();
		isRunning = false;
		clearToolTitleWarnings();
		const hadAgentFailure = event.messages.some((message) => {
			if (message.role !== "assistant" || !("stopReason" in message)) {
				return false;
			}
			return message.stopReason === "error" || message.stopReason === "aborted";
		});
		if (!hadAgentFailure && !hasFailureAttention) {
			hasCompletedRun = true;
			if (ctx.hasUI) {
				lastEditorText = ctx.ui.getEditorText();
			}
		}
		if (hadAgentFailure) {
			setFailureAttention(ctx, true);
		} else {
			refreshTitle(ctx);
		}
		await requestWidgetUpdate(ctx, { skipPullRequestLookup: true });
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		finalizeActiveTurn();
		finalizeActiveLoop();
		isRunning = false;
		hasFailureAttention = false;
		clearToolTitleWarnings();
		clearExternalTitleAttention();
		stopTypingWatcher();
		stopTitleSpinner();
		activeContext = null;
		lastTitle = "";
		ctx.ui.setTitle(getBaseTitle(ctx.cwd, pi.getSessionName()));
		removeTitleAttentionListener();
	});

	pi.registerCommand("custom-status", {
		description: "Toggle custom status widget and title behavior",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			if (!ctx.hasUI) {
				return;
			}
			if (enabled) {
				hasFailureAttention = false;
				await applyEnabledState(ctx);
				ctx.ui.notify("Custom status enabled", "info");
				return;
			}
			await applyEnabledState(ctx);
			ctx.ui.notify("Custom status disabled", "info");
		},
	});
}
