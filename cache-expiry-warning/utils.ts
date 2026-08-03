export const SHORT_CACHE_TTL_MS = 5 * 60 * 1000;
export const ONE_HOUR_CACHE_TTL_MS = 60 * 60 * 1000;
export const ONE_DAY_CACHE_TTL_MS = 24 * ONE_HOUR_CACHE_TTL_MS;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCacheTtl(value: unknown): number | null {
	if (typeof value !== "string") {
		return null;
	}
	const match = value.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)(m|h|d)$/);
	if (!match) {
		return null;
	}
	const amount = Number(match[1]);
	if (!Number.isFinite(amount) || amount <= 0) {
		return null;
	}
	const unitMs = match[2] === "m" ? 60_000 : match[2] === "h" ? ONE_HOUR_CACHE_TTL_MS : ONE_DAY_CACHE_TTL_MS;
	const ttlMs = amount * unitMs;
	return ttlMs <= 0x7fffffff ? ttlMs : null;
}

type CacheDirectiveScan = {
	hasUnknownTtl: boolean;
	ttls: number[];
};

function collectCacheDirectives(value: unknown, scan: CacheDirectiveScan): void {
	if (Array.isArray(value)) {
		for (const item of value) {
			collectCacheDirectives(item, scan);
		}
		return;
	}
	if (!isRecord(value)) {
		return;
	}

	for (const [key, child] of Object.entries(value)) {
		if (isRecord(child)) {
			const isCacheControl = (key === "cache_control" || key === "cacheControl") && child.type === "ephemeral";
			const isCachePoint = key === "cachePoint" && child.type === "default";
			if (isCacheControl || isCachePoint) {
				if (child.ttl === undefined) {
					scan.ttls.push(SHORT_CACHE_TTL_MS);
				} else {
					const ttl = parseCacheTtl(child.ttl);
					if (ttl === null) {
						scan.hasUnknownTtl = true;
					} else {
						scan.ttls.push(ttl);
					}
				}
			}
		}
		collectCacheDirectives(child, scan);
	}
}

/**
 * Inspect the prompt-cache TTL serialized into a provider payload.
 * `undefined` means no cache metadata was present; `null` means caching was
 * configured but its TTL was unknown or caching was explicitly disabled.
 */
export function inspectPromptCacheTtl(payload: unknown): number | null | undefined {
	if (!isRecord(payload)) {
		return undefined;
	}

	const scan: CacheDirectiveScan = { hasUnknownTtl: false, ttls: [] };
	collectCacheDirectives(payload, scan);
	if (payload.prompt_cache_retention !== undefined) {
		const promptCacheRetention = parseCacheTtl(payload.prompt_cache_retention);
		if (promptCacheRetention === null) {
			scan.hasUnknownTtl = true;
		} else {
			scan.ttls.push(promptCacheRetention);
		}
	}
	if (scan.hasUnknownTtl) {
		return null;
	}
	if (scan.ttls.length > 0) {
		return Math.min(...scan.ttls);
	}

	const options = isRecord(payload.options) ? payload.options : null;
	const retention = options?.cacheRetention;
	if (retention === "long" || retention === "none") {
		return null;
	}
	const hasPromptCacheKey = typeof payload.prompt_cache_key === "string" && payload.prompt_cache_key.length > 0;
	if (hasPromptCacheKey || retention === "short") {
		return SHORT_CACHE_TTL_MS;
	}
	return undefined;
}

export function formatCacheTtl(ttlMs: number): string {
	if (ttlMs % ONE_DAY_CACHE_TTL_MS === 0) {
		const days = ttlMs / ONE_DAY_CACHE_TTL_MS;
		return `${days} day${days === 1 ? "" : "s"}`;
	}
	if (ttlMs % ONE_HOUR_CACHE_TTL_MS === 0) {
		const hours = ttlMs / ONE_HOUR_CACHE_TTL_MS;
		return `${hours} hour${hours === 1 ? "" : "s"}`;
	}
	const minutes = Math.round(ttlMs / 60_000);
	return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}
