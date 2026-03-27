import os from "node:os";
import path from "node:path";

export const UNKNOWN_VALUE = "--";
export const OPENAI_PARAMS_EVENT_CHANNEL = "pi:openai-params";

export type OpenAIParamsVerbosity = "low" | "medium" | "high";

export type OpenAIParamsEventPayload = {
	source: "openai-params";
	cwd: string;
	fast: boolean;
	verbosity: OpenAIParamsVerbosity | null;
};

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

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeOpenAIParamsVerbosity(value: unknown): OpenAIParamsVerbosity | null | undefined {
	if (value === null) {
		return null;
	}
	if (typeof value !== "string") {
		return undefined;
	}

	const normalized = value.trim().toLowerCase();
	if (normalized === "low" || normalized === "medium" || normalized === "high") {
		return normalized;
	}
	return undefined;
}

export function parseOpenAIParamsEvent(data: unknown): OpenAIParamsEventPayload | null {
	if (!isObject(data)) {
		return null;
	}

	const source = typeof data.source === "string" ? data.source.trim() : "";
	const cwd = typeof data.cwd === "string" ? data.cwd.trim() : "";
	const fast = typeof data.fast === "boolean" ? data.fast : null;
	const verbosity = normalizeOpenAIParamsVerbosity(data.verbosity);
	if (source !== "openai-params" || !cwd || fast === null || verbosity === undefined) {
		return null;
	}

	return {
		source: "openai-params",
		cwd,
		fast,
		verbosity,
	};
}

export function formatOpenAIParamsLabel(
	params?: Pick<OpenAIParamsEventPayload, "fast" | "verbosity"> | null,
): string | null {
	if (!params) {
		return null;
	}

	const labels: string[] = [];
	if (params.fast) {
		labels.push("/fast");
	}
	if (params.verbosity) {
		labels.push(`🗣️${params.verbosity}`);
	}
	return labels.length > 0 ? labels.join(" ") : null;
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

export function formatContextPercent(usage?: { percent: number | null } | null): string {
	if (!usage || usage.percent === null || Number.isNaN(usage.percent)) {
		return UNKNOWN_VALUE;
	}
	return `${Math.round(usage.percent)}%`;
}

export function formatTokenCount(count?: number | null): string {
	if (count === null || count === undefined || Number.isNaN(count) || count < 0) {
		return UNKNOWN_VALUE;
	}

	const rounded = Math.round(count);
	if (rounded < 1000) {
		return rounded.toString();
	}
	if (rounded < 10_000) {
		return `${(rounded / 1000).toFixed(1)}k`;
	}
	if (rounded < 1_000_000) {
		return `${Math.round(rounded / 1000)}k`;
	}
	if (rounded < 10_000_000) {
		return `${(rounded / 1_000_000).toFixed(1)}M`;
	}
	return `${Math.round(rounded / 1_000_000)}M`;
}

export function formatContextLabel(usage?: { percent: number | null; tokens: number | null } | null): string {
	const percent = formatContextPercent(usage);
	const tokens = formatTokenCount(usage?.tokens ?? null);

	if (percent !== UNKNOWN_VALUE && tokens !== UNKNOWN_VALUE) {
		return `${percent} (${tokens})`;
	}
	if (percent !== UNKNOWN_VALUE) {
		return percent;
	}
	if (tokens !== UNKNOWN_VALUE) {
		return tokens;
	}
	return UNKNOWN_VALUE;
}

export function formatElapsedMinutes(minutes?: number | null): string {
	if (minutes === null || minutes === undefined || Number.isNaN(minutes) || minutes < 0) {
		return UNKNOWN_VALUE;
	}

	const totalMinutes = Math.floor(minutes);
	const dayMinutes = 24 * 60;

	if (totalMinutes >= dayMinutes) {
		const days = Math.floor(totalMinutes / dayMinutes);
		const remainingMinutes = totalMinutes % dayMinutes;
		const hours = Math.floor(remainingMinutes / 60);
		const mins = remainingMinutes % 60;
		return `${days}d${hours}h${mins}m`;
	}

	if (totalMinutes >= 60) {
		const hours = Math.floor(totalMinutes / 60);
		const mins = totalMinutes % 60;
		return `${hours}h${mins}m`;
	}

	return `${totalMinutes}m`;
}

export function elapsedDurationMs(startedAt: number | null, now = Date.now()): number {
	if (startedAt === null || Number.isNaN(startedAt)) {
		return 0;
	}
	return Math.max(0, now - startedAt);
}

export function activeAgentDurationMs(
	completedTurnDurationMs: number,
	activeTurnStartedAt: number | null,
	now = Date.now(),
): number {
	const completed = Number.isNaN(completedTurnDurationMs) ? 0 : Math.max(0, completedTurnDurationMs);
	return completed + elapsedDurationMs(activeTurnStartedAt, now);
}

export function carryForwardTimingDurations(
	sessionDurationCarryMs: number,
	agentDurationCarryMs: number,
	sessionStartedAt: number | null,
	completedTurnDurationMs: number,
	activeTurnStartedAt: number | null,
	now = Date.now(),
): { sessionDurationCarryMs: number; agentDurationCarryMs: number } {
	const safeSessionCarry = Number.isNaN(sessionDurationCarryMs) ? 0 : Math.max(0, sessionDurationCarryMs);
	const safeAgentCarry = Number.isNaN(agentDurationCarryMs) ? 0 : Math.max(0, agentDurationCarryMs);
	return {
		sessionDurationCarryMs: safeSessionCarry + elapsedDurationMs(sessionStartedAt, now),
		agentDurationCarryMs: safeAgentCarry + activeAgentDurationMs(completedTurnDurationMs, activeTurnStartedAt, now),
	};
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

export type PullRequestSummary = {
	url?: string | null;
	state?: string | null;
	updatedAt?: string | null;
	headRefName?: string | null;
	headRepositoryOwner?: {
		login?: string | null;
	} | null;
};

export type GitRemoteRepo = {
	host: string;
	owner: string;
	name: string;
	repoSelector: string;
};

const DEFAULT_GITHUB_HOSTS = ["github.com"] as const;

function normalizeHost(host?: string | null): string | null {
	const normalized = host?.trim().toLowerCase().replace(/\.$/, "") ?? "";
	if (!normalized) {
		return null;
	}
	return normalized;
}

export function parseAllowedGitHubHosts(raw?: string | null): Set<string> {
	const allowed = new Set<string>(DEFAULT_GITHUB_HOSTS);
	if (!raw?.trim()) {
		return allowed;
	}
	for (const part of raw.split(",")) {
		const normalized = normalizeHost(part);
		if (normalized) {
			allowed.add(normalized);
		}
	}
	return allowed;
}

export function isGitHubHost(host?: string | null, allowedHosts?: ReadonlySet<string>): boolean {
	const normalized = normalizeHost(host);
	if (!normalized) {
		return false;
	}
	const allowed = allowedHosts ?? new Set<string>(DEFAULT_GITHUB_HOSTS);
	return allowed.has(normalized);
}

function normalizeRepoName(repo: string): string {
	return repo.replace(/\.git$/i, "").trim();
}

export function parseGitRemoteRepo(remoteUrl?: string | null): GitRemoteRepo | null {
	const value = remoteUrl?.trim();
	if (!value) {
		return null;
	}

	const parsePath = (host: string, rawPath: string): GitRemoteRepo | null => {
		const pathValue = rawPath.replace(/^\/+/, "").replace(/\/+$/, "");
		const parts = pathValue.split("/");
		if (parts.length < 2) {
			return null;
		}
		const owner = parts[0]?.trim();
		const name = normalizeRepoName(parts[1] ?? "");
		if (!host.trim() || !owner || !name) {
			return null;
		}
		const hostValue = host.trim().toLowerCase();
		const repoSelector = hostValue === "github.com" ? `${owner}/${name}` : `${hostValue}/${owner}/${name}`;
		return {
			host: hostValue,
			owner,
			name,
			repoSelector,
		};
	};

	if (value.includes("://")) {
		try {
			const parsed = new URL(value);
			return parsePath(parsed.hostname, parsed.pathname);
		} catch {
			return null;
		}
	}

	const scpLikeMatch = value.match(/^(?:[^@]+@)?([^:]+):(.+)$/);
	if (scpLikeMatch) {
		const host = scpLikeMatch[1] ?? "";
		const pathPart = scpLikeMatch[2] ?? "";
		return parsePath(host, pathPart);
	}

	return null;
}

export function filterPullRequestsByHeadOwner(prs: PullRequestSummary[], branch: string, owner: string): PullRequestSummary[] {
	const normalizedBranch = branch.trim();
	const normalizedOwner = owner.trim().toLowerCase();

	const branchMatches = prs.filter((pr) => {
		const headRefName = pr.headRefName?.trim();
		return headRefName ? headRefName === normalizedBranch : true;
	});
	const scoped = branchMatches.length > 0 ? branchMatches : prs;

	if (!normalizedOwner) {
		return scoped;
	}

	const ownerMatches = scoped.filter((pr) => pr.headRepositoryOwner?.login?.trim().toLowerCase() === normalizedOwner);
	if (ownerMatches.length > 0) {
		return ownerMatches;
	}

	// Fail closed when owner disambiguation does not match.
	return [];
}

export function pickPullRequest(prs: PullRequestSummary[]): PullRequestSummary | null {
	const candidates = prs.filter((pr) => pr.url?.trim());
	if (candidates.length === 0) {
		return null;
	}

	const open = candidates.find((pr) => pr.state?.toUpperCase() === "OPEN");
	if (open) {
		return open;
	}

	const sorted = [...candidates].sort((a, b) => {
		const aTime = a.updatedAt ? Date.parse(a.updatedAt) : Number.NaN;
		const bTime = b.updatedAt ? Date.parse(b.updatedAt) : Number.NaN;
		const aSafe = Number.isNaN(aTime) ? 0 : aTime;
		const bSafe = Number.isNaN(bTime) ? 0 : bTime;
		return bSafe - aSafe;
	});
	return sorted[0] ?? null;
}

export function formatPullRequestLabel(pr?: PullRequestSummary | null): string | null {
	const url = pr?.url?.trim();
	if (!url) {
		return null;
	}
	const state = pr?.state?.trim().toUpperCase();
	if (!state || state === "OPEN") {
		return `PR: ${url}`;
	}
	return `PR: ${url} (${state.toLowerCase()})`;
}
