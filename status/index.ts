import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import {
	filterPullRequestsByHeadOwner,
	formatContextPercent,
	formatLoopMinutes,
	formatModelLabel,
	formatPullRequestLabel,
	formatRepoLabel,
	formatThinkingLevel,
	isGitHubHost,
	parseAllowedGitHubHosts,
	parseGitRemoteRepo,
	pickPullRequest,
	type GitRemoteRepo,
	type PullRequestSummary,
} from "./utils";

const STATUS_WIDGET_KEY = "status";
const RUNNING_EMOJI = "♨️";
const DONE_EMOJI = "✅";
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
		const thinkingLabel = theme.fg(resolveThinkingColor(payload.thinkingLevel), `(${payload.thinkingLevel})`);
		const contextLabel = theme.fg(resolveContextColor(payload.contextUsage), payload.contextPercent);
		const loopMinutesLabel = theme.fg("muted", payload.loopMinutesLabel);
		const repoLabel = theme.fg("muted", payload.repoLabel);
		const right = `${modelLabel} ${thinkingLabel} ${contextLabel} ${loopMinutesLabel}`;
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
	let isTyping = false;
	let suppressDoneEmoji = false;
	let lastTitle = "";
	let typingTimer: ReturnType<typeof setInterval> | null = null;
	let activeContext: ExtensionContext | null = null;
	let lastThinkingLevel = "";
	let enabled = true;
	let activeLoopStartedAt: number | null = null;
	let lastLoopMinutes: number | null = null;
	const allowedGitHubHosts = parseAllowedGitHubHosts(process.env.PI_STATUS_ALLOWED_GITHUB_HOSTS);
	let remoteRepoCache = new Map<string, RemoteRepoCacheEntry>();
	let remoteRepoRequestsInFlight = new Map<string, Promise<GitRemoteRepo | null>>();
	let prCache = new Map<string, PullRequestCacheEntry>();
	let prRequestsInFlight = new Map<string, Promise<PullRequestSummary | null>>();
	let lastPeriodicPrRefreshAt = 0;
	let pendingWidgetUpdateCtx: ExtensionContext | null = null;
	let pendingWidgetUpdateOptions: WidgetUpdateOptions | null = null;
	let widgetUpdateRunner: Promise<void> | null = null;

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
		void requestWidgetUpdate(ctx);
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
		void requestWidgetUpdate(ctx);
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
			maybeRefreshPullRequest(activeContext);
		}, 200);
		updateTypingState(ctx);
		updateThinkingLevel(ctx);
		updateLoopMinutes(ctx);
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
		const payload: StatusPayload = {
			modelLabel: formatModelLabel(ctx.model),
			thinkingLevel: formatThinkingLevel(pi.getThinkingLevel()),
			contextPercent: formatContextPercent(usage),
			contextUsage: usage?.percent ?? null,
			repoLabel: formatRepoLabel(ctx.cwd, branch),
			loopMinutesLabel: formatLoopMinutes(getLoopMinutes()),
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
			lastSignature = "";
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
		await requestWidgetUpdate(ctx);
	});

	pi.on("input", async (_event, ctx) => {
		updateTypingState(ctx);
		await requestWidgetUpdate(ctx, { skipPullRequestLookup: true });
	});

	pi.on("user_bash", async (_event, ctx) => {
		await requestWidgetUpdate(ctx, { forceRepoRefresh: true });
	});

	pi.on("agent_start", async (_event, ctx) => {
		isRunning = true;
		activeLoopStartedAt = Date.now();
		lastLoopMinutes = 0;
		suppressDoneEmoji = false;
		refreshTitle(ctx);
		await requestWidgetUpdate(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		await requestWidgetUpdate(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (activeLoopStartedAt !== null) {
			lastLoopMinutes = Math.max(0, Math.floor((Date.now() - activeLoopStartedAt) / 60_000));
			activeLoopStartedAt = null;
		}
		isRunning = false;
		refreshTitle(ctx);
		await requestWidgetUpdate(ctx);
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
