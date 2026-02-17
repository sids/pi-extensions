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

export function formatContextPercent(usage?: { percent: number | null } | null): string {
	if (!usage || usage.percent === null || Number.isNaN(usage.percent)) {
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
