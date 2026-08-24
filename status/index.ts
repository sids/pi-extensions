import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	activeAgentDurationMs,
	elapsedDurationMs,
	filterPullRequestsByHeadOwner,
	formatContextLabel,
	formatElapsedMinutes,
	formatModelLabel,
	formatOpenAIParamsLabel,
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
import {
	createStatusDetailsWidget,
	createStatusHeaderWidget,
	type PullRequestViewData,
	type StatusDetailsPayload,
	type StatusHeaderPayload,
} from "./view";

const STATUS_HEADER_WIDGET_KEY = "pi-status.header";
const STATUS_DETAILS_WIDGET_KEY = "pi-status.details";
const THINKING_POLL_INTERVAL_MS = 250;
const TIMING_POLL_INTERVAL_MS = 1_000;
const REPOSITORY_POLL_INTERVAL_MS = 1_000;
const REMOTE_REPO_CACHE_TTL_MS = 5_000;
const PR_CACHE_TTL_MS = 30_000;
const PR_POLL_INTERVAL_MS = 30_000;

type HeaderUpdateOptions = {
	skipPullRequestLookup?: boolean;
};

const createEmptyFooter = () => (_tui: unknown, _theme: unknown, _footerData: unknown) => ({
	render: () => [],
	invalidate: () => {},
});

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
): Promise<GitRemoteRepo | null> {
	const cached = cache.get(cwd);
	if (cached && Date.now() - cached.checkedAt < REMOTE_REPO_CACHE_TTL_MS) {
		return cached.repo;
	}

	const checkedAt = Date.now();
	try {
		const result = await pi.exec("git", ["config", "--get", "remote.origin.url"], { cwd, timeout: 1500 });
		const repo = result.code === 0 ? parseGitRemoteRepo(result.stdout) : null;
		cache.set(cwd, { checkedAt, repo });
		return repo;
	} catch {
		cache.set(cwd, { checkedAt, repo: null });
		return null;
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

function toPullRequestViewData(pullRequest: PullRequestSummary | null): PullRequestViewData | null {
	const url = pullRequest?.url?.trim();
	if (!url) {
		return null;
	}
	return {
		url,
		state: pullRequest?.state?.trim().toUpperCase() || null,
	};
}

async function resolveGitPullRequest(
	pi: ExtensionAPI,
	cwd: string,
	repo: GitRemoteRepo | null,
	branch: string | null,
	cache: Map<string, PullRequestCacheEntry>,
	allowedGitHubHosts: ReadonlySet<string>,
): Promise<PullRequestSummary | null> {
	if (!repo || !branch || branch === "detached" || !isGitHubHost(repo.host, allowedGitHubHosts)) {
		return null;
	}

	const cacheKey = `${repo.repoSelector}:${branch}`;
	const cached = cache.get(cacheKey);
	if (cached && Date.now() - cached.checkedAt < PR_CACHE_TTL_MS) {
		return cached.pr;
	}

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
}

export default function (pi: ExtensionAPI) {
	let lastHeaderSignature = "";
	let lastDetailsSignature = "";
	let thinkingTimer: ReturnType<typeof setInterval> | null = null;
	let timingTimer: ReturnType<typeof setInterval> | null = null;
	let repositoryTimer: ReturnType<typeof setInterval> | null = null;
	let pullRequestTimer: ReturnType<typeof setInterval> | null = null;
	let lastThinkingLevel = "";
	let enabled = true;
	let sessionStartedAt: number | null = Date.now();
	let activeAgentStartedAt: number | null = null;
	let lastAgentDurationMs: number | null = null;
	let activeTurnStartedAt: number | null = null;
	let completedTurnDurationMs = 0;
	let lastTimingSignature = "";
	let lastRepositoryKey = "";
	const allowedGitHubHosts = parseAllowedGitHubHosts(process.env.PI_STATUS_ALLOWED_GITHUB_HOSTS);
	const remoteRepoCache = new Map<string, RemoteRepoCacheEntry>();
	const prCache = new Map<string, PullRequestCacheEntry>();
	const openAIParamsByCwd = new Map<string, OpenAIParamsEventPayload>();
	let currentCtx: ExtensionContext | null = null;
	let headerUpdateQueue = Promise.resolve();

	const resetHeaderState = () => {
		lastHeaderSignature = "";
		lastRepositoryKey = "";
		remoteRepoCache.clear();
		prCache.clear();
	};

	const resetTimingState = (now = Date.now()) => {
		sessionStartedAt = now;
		activeAgentStartedAt = null;
		lastAgentDurationMs = null;
		activeTurnStartedAt = null;
		completedTurnDurationMs = 0;
	};

	const finalizeActiveAgent = (now = Date.now()) => {
		if (activeAgentStartedAt === null) {
			return;
		}
		lastAgentDurationMs = Math.max(0, now - activeAgentStartedAt);
		activeAgentStartedAt = null;
	};

	const beginAgent = (now = Date.now()) => {
		if (activeTurnStartedAt !== null) {
			finalizeActiveTurn(now);
		}
		if (activeAgentStartedAt === null) {
			activeAgentStartedAt = now;
			lastAgentDurationMs = 0;
		}
	};

	const finalizeActiveTurn = (now = Date.now()) => {
		if (activeTurnStartedAt === null) {
			return;
		}
		completedTurnDurationMs += Math.max(0, now - activeTurnStartedAt);
		activeTurnStartedAt = null;
	};

	const beginTurn = (now = Date.now()) => {
		if (activeTurnStartedAt !== null) {
			finalizeActiveTurn(now);
		}
		activeTurnStartedAt = now;
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

	const refreshTimingDetails = (ctx: ExtensionContext) => {
		lastTimingSignature = getTimingSignature();
		updateDetailsWidget(ctx);
	};

	const updateTimingMetrics = (ctx: ExtensionContext) => {
		if (getTimingSignature() !== lastTimingSignature) {
			refreshTimingDetails(ctx);
		}
	};

	const updateThinkingLevel = (ctx: ExtensionContext) => {
		const current = formatThinkingLevel(pi.getThinkingLevel());
		if (current === lastThinkingLevel) {
			return;
		}
		lastThinkingLevel = current;
		updateDetailsWidget(ctx);
	};

	const stopWatchers = () => {
		if (thinkingTimer) {
			clearInterval(thinkingTimer);
			thinkingTimer = null;
		}
		if (timingTimer) {
			clearInterval(timingTimer);
			timingTimer = null;
		}
		if (repositoryTimer) {
			clearInterval(repositoryTimer);
			repositoryTimer = null;
		}
		if (pullRequestTimer) {
			clearInterval(pullRequestTimer);
			pullRequestTimer = null;
		}
	};

	const startWatchers = (ctx: ExtensionContext) => {
		stopWatchers();
		thinkingTimer = setInterval(() => updateThinkingLevel(ctx), THINKING_POLL_INTERVAL_MS);
		timingTimer = setInterval(() => updateTimingMetrics(ctx), TIMING_POLL_INTERVAL_MS);
		repositoryTimer = setInterval(
			() => void requestHeaderUpdate(ctx, { skipPullRequestLookup: true }),
			REPOSITORY_POLL_INTERVAL_MS,
		);
		pullRequestTimer = setInterval(() => void requestHeaderUpdate(ctx), PR_POLL_INTERVAL_MS);
	};

	const disableDefaultFooter = (ctx: ExtensionContext) => {
		ctx.ui.setFooter(createEmptyFooter());
	};

	const updateDetailsWidget = (ctx: ExtensionContext) => {
		if (!ctx.hasUI || !enabled) {
			return;
		}
		const usage = ctx.getContextUsage();
		const timings = getTimingMinutes();
		const openAIParamsLabel = formatOpenAIParamsLabel(openAIParamsByCwd.get(ctx.cwd), ctx.model);
		const payload: StatusDetailsPayload = {
			modelLabel: formatModelLabel(ctx.model),
			thinkingLevel: formatThinkingLevel(pi.getThinkingLevel()),
			...(openAIParamsLabel ? { openAIParamsLabel } : {}),
			contextLabel: formatContextLabel(usage),
			contextUsage: usage?.percent ?? null,
			agentMinutesLabel: formatElapsedMinutes(timings.agent),
			turnTotalMinutesLabel: formatElapsedMinutes(timings.turnTotal),
			sessionMinutesLabel: formatElapsedMinutes(timings.session),
		};
		const signature = JSON.stringify(payload);
		if (signature === lastDetailsSignature) {
			return;
		}
		lastDetailsSignature = signature;
		ctx.ui.setWidget(STATUS_DETAILS_WIDGET_KEY, createStatusDetailsWidget(payload), { placement: "belowEditor" });
	};

	const updateHeaderWidget = async (ctx: ExtensionContext, options?: HeaderUpdateOptions) => {
		if (!ctx.hasUI || !enabled) {
			return;
		}
		const branch = await resolveGitBranch(pi, ctx.cwd);
		const repo = await resolveGitRemoteRepo(pi, ctx.cwd, remoteRepoCache);
		const repositoryKey = `${repo?.repoSelector ?? ""}:${branch ?? ""}`;
		const repositoryChanged = repositoryKey !== lastRepositoryKey;
		lastRepositoryKey = repositoryKey;
		const pullRequest = options?.skipPullRequestLookup && !repositoryChanged
			? getCachedPullRequest(repo, branch, prCache)
			: await resolveGitPullRequest(pi, ctx.cwd, repo, branch, prCache, allowedGitHubHosts);

		const payload: StatusHeaderPayload = {
			repoLabel: formatRepoLabel(ctx.cwd, branch),
			sessionName: pi.getSessionName()?.trim() || null,
			pullRequest: toPullRequestViewData(pullRequest),
		};
		const signature = JSON.stringify(payload);
		if (signature === lastHeaderSignature) {
			return;
		}
		lastHeaderSignature = signature;
		ctx.ui.setWidget(STATUS_HEADER_WIDGET_KEY, createStatusHeaderWidget(payload));
	};

	const requestHeaderUpdate = (ctx: ExtensionContext, options?: HeaderUpdateOptions): Promise<void> => {
		currentCtx = ctx;
		const update = headerUpdateQueue.then(() => updateHeaderWidget(ctx, options));
		headerUpdateQueue = update.catch(() => {});
		return update;
	};

	pi.events.on(OPENAI_PARAMS_EVENT_CHANNEL, (data) => {
		const parsed = parseOpenAIParamsEvent(data);
		if (!parsed) {
			return;
		}

		openAIParamsByCwd.set(parsed.cwd, parsed);
		if (currentCtx?.cwd === parsed.cwd) {
			updateDetailsWidget(currentCtx);
		}
	});

	const applyEnabledState = async (ctx: ExtensionContext) => {
		currentCtx = ctx;
		if (!ctx.hasUI) {
			return;
		}
		if (enabled) {
			resetHeaderState();
			lastDetailsSignature = "";
			lastThinkingLevel = formatThinkingLevel(pi.getThinkingLevel());
			disableDefaultFooter(ctx);
			refreshTimingDetails(ctx);
			startWatchers(ctx);
			await requestHeaderUpdate(ctx);
		} else {
			ctx.ui.setWidget(STATUS_HEADER_WIDGET_KEY, undefined);
			ctx.ui.setWidget(STATUS_DETAILS_WIDGET_KEY, undefined, { placement: "belowEditor" });
			ctx.ui.setFooter(undefined);
			stopWatchers();
			resetHeaderState();
			lastDetailsSignature = "";
			lastTimingSignature = "";
			lastThinkingLevel = "";
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		resetTimingState();
		await applyEnabledState(ctx);
	});

	pi.on("session_info_changed", async (_event, ctx) => {
		await requestHeaderUpdate(ctx, { skipPullRequestLookup: true });
	});

	pi.on("model_select", (_event, ctx) => {
		updateDetailsWidget(ctx);
	});

	pi.on("input", (_event, ctx) => {
		updateDetailsWidget(ctx);
	});

	pi.on("session_compact", (_event, ctx) => {
		updateDetailsWidget(ctx);
	});

	pi.on("agent_start", (_event, ctx) => {
		beginAgent();
		refreshTimingDetails(ctx);
	});

	pi.on("turn_start", (_event, ctx) => {
		beginTurn();
		refreshTimingDetails(ctx);
	});

	pi.on("turn_end", (_event, ctx) => {
		finalizeActiveTurn();
		refreshTimingDetails(ctx);
	});

	pi.on("agent_end", (_event, ctx) => {
		finalizeActiveTurn();
		refreshTimingDetails(ctx);
	});

	pi.on("agent_settled", (_event, ctx) => {
		finalizeActiveTurn();
		finalizeActiveAgent();
		refreshTimingDetails(ctx);
	});

	pi.on("session_shutdown", () => {
		finalizeActiveTurn();
		finalizeActiveAgent();
		stopWatchers();
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
