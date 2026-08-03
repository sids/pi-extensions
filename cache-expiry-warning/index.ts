import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text, type TUI } from "@earendil-works/pi-tui";
import { formatCacheTtl, inspectPromptCacheTtl } from "./utils";

const PROMPT_CACHE_RETENTION_EVENT_CHANNEL = "pi:prompt-cache-retention";
const WIDGET_KEY = "cache-expiry-warning";

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePromptCacheRetentionEvent(data: unknown): {
	cwd: string;
	cacheTtlMs: number;
	requestStartedAtMs: number;
} | null {
	if (
		!isObject(data) ||
		typeof data.cwd !== "string" ||
		typeof data.cacheTtlMs !== "number" ||
		!Number.isFinite(data.cacheTtlMs) ||
		data.cacheTtlMs <= 0 ||
		typeof data.requestStartedAtMs !== "number" ||
		!Number.isFinite(data.requestStartedAtMs)
	) {
		return null;
	}
	return {
		cwd: data.cwd,
		cacheTtlMs: data.cacheTtlMs,
		requestStartedAtMs: data.requestStartedAtMs,
	};
}

function createWarningWidget(ttlMs: number) {
	return (_tui: TUI, theme: Theme) =>
		new Text(
			theme.fg(
				"warning",
				`⚠ Prompt cache may have expired after ${formatCacheTtl(ttlMs)} of inactivity; the next turn may rebuild it.`,
			),
			0,
			0,
		);
}

export default function cacheExpiryExtension(pi: ExtensionAPI): void {
	let expiryTimer: ReturnType<typeof setTimeout> | null = null;
	let activeTurn: {
		cwd: string;
		cacheTtlMs: number | null | undefined;
		requestStartedAtMs?: number;
		retentionReported: boolean;
	} | null = null;

	const clearTimer = () => {
		if (expiryTimer !== null) {
			clearTimeout(expiryTimer);
			expiryTimer = null;
		}
	};

	const clearWarning = (ctx: ExtensionContext) => {
		clearTimer();
		if (ctx.hasUI) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
		}
	};

	const reset = (ctx: ExtensionContext) => {
		activeTurn = null;
		clearWarning(ctx);
	};

	pi.on("session_start", (_event, ctx) => reset(ctx));

	pi.events.on(PROMPT_CACHE_RETENTION_EVENT_CHANNEL, (data) => {
		const retention = parsePromptCacheRetentionEvent(data);
		if (!activeTurn || !retention || retention.cwd !== activeTurn.cwd) {
			return;
		}
		activeTurn.cacheTtlMs = retention.cacheTtlMs;
		activeTurn.requestStartedAtMs = retention.requestStartedAtMs;
		activeTurn.retentionReported = true;
	});

	pi.on("before_provider_request", (event) => {
		if (activeTurn && !activeTurn.retentionReported) {
			activeTurn.cacheTtlMs = inspectPromptCacheTtl(event.payload);
			activeTurn.requestStartedAtMs = Date.now();
		}
	});

	pi.on("turn_start", (_event, ctx) => {
		activeTurn = { cwd: ctx.cwd, cacheTtlMs: undefined, retentionReported: false };
		clearWarning(ctx);
	});

	pi.on("turn_end", (_event, ctx) => {
		clearTimer();
		const completedTurn = activeTurn;
		activeTurn = null;
		const ttlMs = completedTurn?.cacheTtlMs;
		const requestStartedAtMs = completedTurn?.requestStartedAtMs;
		if (ttlMs === null || ttlMs === undefined || requestStartedAtMs === undefined || !ctx.hasUI) {
			return;
		}

		const elapsedMs = Math.max(0, Date.now() - requestStartedAtMs);
		const remainingMs = Math.max(0, ttlMs - elapsedMs);
		const showWarning = () => ctx.ui.setWidget(WIDGET_KEY, createWarningWidget(ttlMs));
		if (remainingMs === 0) {
			showWarning();
			return;
		}
		expiryTimer = setTimeout(() => {
			expiryTimer = null;
			showWarning();
		}, remainingMs);
		expiryTimer.unref?.();
	});

	pi.on("model_select", (_event, ctx) => reset(ctx));
	pi.on("session_shutdown", (_event, ctx) => reset(ctx));
}
