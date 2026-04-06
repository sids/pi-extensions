import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import {
	activeAgentDurationMs,
	elapsedDurationMs,
	filterPullRequestsByHeadOwner,
	formatContextLabel,
	formatElapsedMinutes,
	formatModelLabel,
	formatOpenAIParamsLabel,
	formatPullRequestLabel,
	formatRepoLabel,
	formatThinkingLevel,
	isGitHubHost,
	OPENAI_PARAMS_EVENT_CHANNEL,
	parseAllowedGitHubHosts,
	parseGitRemoteRepo,
	parseOpenAIParamsEvent,
	pickPullRequest,
	type GitRemoteRepo,
	type OpenAIParamsEventPayload,
	type PullRequestSummary,
} from "./utils";

const STATUS_WIDGET_KEY = "status";
const STATUS_POLL_INTERVAL_MS = 250;
const REMOTE_REPO_CACHE_TTL_MS = 30_000;
const PR_CACHE_TTL_MS = 30_000;
const PR_POLL_INTERVAL_MS = 30_000;

type StatusPayload = {
	modelLabel: string;
	thinkingLevel: string;
	openAIParamsLabel?: string;
	contextLabel: string;
	contextUsage: number | null;
	repoLabel: string;
	agentMinutesLabel: string;
	turnTotalMinutesLabel: string;
	sessionMinutesLabel: string;
	pullRequestLabel: string | null;
};

type WidgetUpdateOptions = {
	forcePrRefresh?: boolean;
	forceRepoRefresh?: boolean;
	skipPullRequestLookup?: boolean;
};

const createStatusWidget = (payload: StatusPayload) => (_tui: unknown, theme: { fg: (name: string, text: string) => string }) => ({
	render: (width: number) => {
		const modelLabel = theme.fg("muted", payload.modelLabel);
		const thinkingLevelLabel = theme.fg(resolveThinkingColor(payload.thinkingLevel), payload.thinkingLevel);
		const openAIParamsLabel = payload.openAIParamsLabel ? ` ${theme.fg("muted", payload.openAIParamsLabel)}` : "";
		const thinkingLabel = `${theme.fg("muted", "(")}${thinkingLevelLabel}${openAIParamsLabel}${theme.fg("muted", ")")}`;
		const contextLabel = theme.fg(resolveContextColor(payload.contextUsage), payload.contextLabel);
		const timingLabel = theme.fg(
			"muted",
			`· ${payload.agentMinutesLabel} agent · ${payload.turnTotalMinutesLabel} turn total · ${payload.sessionMinutesLabel} session`,
		);
		const repoLabel = theme.fg("muted", payload.repoLabel);
		const right = [modelLabel, thinkingLabel, contextLabel, timingLabel].join(" ");
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
	let typingTimer: ReturnType<typeof setInterval> | null = null;
	let lastThinkingLevel = "";
	let enabled = true;
	let sessionStartedAt: number | null = Date.now();
	let activeAgentStartedAt: number | null = null;
	let lastAgentDurationMs: number | null = null;
	let activeTurnStartedAt: number | null = null;
	let completedTurnDurationMs = 0;
	let lastTimingSignature = "";
	const allowedGitHubHosts = parseAllowedGitHubHosts(process.env.PI_STATUS_ALLOWED_GITHUB_HOSTS);
	let remoteRepoCache = new Map<string, RemoteRepoCacheEntry>();
	let remoteRepoRequestsInFlight = new Map<string, Promise<GitRemoteRepo | null>>();
	let prCache = new Map<string, PullRequestCacheEntry>();
	let prRequestsInFlight = new Map<string, Promise<PullRequestSummary | null>>();
	let openAIParamsByCwd = new Map<string, OpenAIParamsEventPayload>();
	let lastPeriodicPrRefreshAt = 0;
	let currentCtx: ExtensionContext | null = null;
	let pendingWidgetUpdateCtx: ExtensionContext | null = null;
	let pendingWidgetUpdateOptions: WidgetUpdateOptions | null = null;
	let widgetUpdateRunner: Promise<void> | null = null;

	const rememberCtx = (ctx: ExtensionContext) => {
		currentCtx = ctx;
	};

	const resetTimingState = (now = Date.now()) => {
		sessionStartedAt = now;
		activeAgentStartedAt = null;
		lastAgentDurationMs = null;
		activeTurnStartedAt = null;
		completedTurnDurationMs = 0;
		lastTimingSignature = "";
	};

	const finalizeActiveAgent = (now = Date.now()): boolean => {
		if (activeAgentStartedAt === null) {
			return false;
		}
		lastAgentDurationMs = Math.max(0, now - activeAgentStartedAt);
		activeAgentStartedAt = null;
		lastTimingSignature = "";
		return true;
	};

	const beginAgent = (now = Date.now()) => {
		if (activeTurnStartedAt !== null) {
			finalizeActiveTurn(now);
		}
		if (activeAgentStartedAt !== null) {
			finalizeActiveAgent(now);
		}
		activeAgentStartedAt = now;
		lastAgentDurationMs = 0;
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

	const getAgentMinutes = (now = Date.now()): number | null => {
		if (activeAgentStartedAt === null) {
			return lastAgentDurationMs === null ? null : lastAgentDurationMs / 60_000;
		}
		return Math.max(0, (now - activeAgentStartedAt) / 60_000);
	};

	const getTimingMinutes = (now = Date.now()): { agent: number | null; turnTotal: number | null; session: number | null } => {
		const agent = getAgentMinutes(now);
		const turnTotalDurationMs = activeAgentDurationMs(completedTurnDurationMs, activeTurnStartedAt, now);
		const sessionDurationMs = elapsedDurationMs(sessionStartedAt, now);
		return {
			agent,
			turnTotal: turnTotalDurationMs / 60_000,
			session: sessionDurationMs / 60_000,
		};
	};

	const getTimingSignature = (now = Date.now()): string => {
		const timings = getTimingMinutes(now);
		return `${formatElapsedMinutes(timings.agent)}|${formatElapsedMinutes(timings.turnTotal)}|${formatElapsedMinutes(timings.session)}`;
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
		if (typingTimer) {
			clearInterval(typingTimer);
		}
		typingTimer = setInterval(() => {
			if (!ctx.hasUI || !enabled) {
				return;
			}
			updateThinkingLevel(ctx);
			updateTimingMetrics(ctx);
			maybeRefreshPullRequest(ctx);
		}, STATUS_POLL_INTERVAL_MS);
		updateThinkingLevel(ctx);
		updateTimingMetrics(ctx);
		maybeRefreshPullRequest(ctx);
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
		const openAIParamsLabel = formatOpenAIParamsLabel(openAIParamsByCwd.get(ctx.cwd) ?? null);
		const payload: StatusPayload = {
			modelLabel: formatModelLabel(ctx.model),
			thinkingLevel: formatThinkingLevel(pi.getThinkingLevel()),
			...(openAIParamsLabel ? { openAIParamsLabel } : {}),
			contextLabel: formatContextLabel(usage),
			contextUsage: usage?.percent ?? null,
			repoLabel: formatRepoLabel(ctx.cwd, branch),
			agentMinutesLabel: formatElapsedMinutes(timings.agent),
			turnTotalMinutesLabel: formatElapsedMinutes(timings.turnTotal),
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
		rememberCtx(ctx);
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

	pi.events.on(OPENAI_PARAMS_EVENT_CHANNEL, (data) => {
		const parsed = parseOpenAIParamsEvent(data);
		if (!parsed) {
			return;
		}

		openAIParamsByCwd.set(parsed.cwd, parsed);
		if (!currentCtx || !currentCtx.hasUI || !enabled || currentCtx.cwd !== parsed.cwd) {
			return;
		}
		void requestWidgetUpdate(currentCtx, { skipPullRequestLookup: true });
	});

	const applyEnabledState = async (ctx: ExtensionContext) => {
		rememberCtx(ctx);
		if (!ctx.hasUI) {
			return;
		}
		if (enabled) {
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
		} else {
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
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		resetTimingState();
		await applyEnabledState(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		if (!enabled) {
			return;
		}
		await requestWidgetUpdate(ctx);
	});

	pi.on("input", async (_event, ctx) => {
		await requestWidgetUpdate(ctx, { skipPullRequestLookup: true });
	});

	pi.on("session_compact", async (_event, ctx) => {
		await requestWidgetUpdate(ctx, { skipPullRequestLookup: true });
	});

	pi.on("user_bash", async (_event, ctx) => {
		await requestWidgetUpdate(ctx, { forceRepoRefresh: true });
	});

	pi.on("agent_start", async (_event, ctx) => {
		beginAgent();
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

	pi.on("agent_end", async (_event, ctx) => {
		finalizeActiveTurn();
		finalizeActiveAgent();
		await requestWidgetUpdate(ctx, { skipPullRequestLookup: true });
	});

	pi.on("session_shutdown", async () => {
		finalizeActiveTurn();
		finalizeActiveAgent();
		stopTypingWatcher();
		currentCtx = null;
	});

	pi.registerCommand("custom-status", {
		description: "Toggle custom status widget",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			if (!ctx.hasUI) {
				return;
			}
			if (enabled) {
				await applyEnabledState(ctx);
				ctx.ui.notify("Custom status enabled", "info");
				return;
			}
			await applyEnabledState(ctx);
			ctx.ui.notify("Custom status disabled", "info");
		},
	});
}
