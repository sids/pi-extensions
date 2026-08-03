export type CountdownTimingOptions = {
	timeoutMs: number;
	countdownTickMs?: number;
	now?: () => number;
};

const DEFAULT_COUNTDOWN_TICK_MS = 250;

export class CountdownController {
	private readonly now: () => number;
	private readonly deadlineMs: number;
	private timeout?: ReturnType<typeof setTimeout>;
	private refreshTimer?: ReturnType<typeof setInterval>;
	private stopped = false;

	constructor(onExpire: () => void, onTick: () => void, options: CountdownTimingOptions) {
		const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, Math.floor(options.timeoutMs)) : 1;
		const countdownTickMs =
			typeof options.countdownTickMs === "number" && Number.isFinite(options.countdownTickMs)
				? Math.max(1, Math.floor(options.countdownTickMs))
				: DEFAULT_COUNTDOWN_TICK_MS;
		this.now = options.now ?? Date.now;
		this.deadlineMs = this.now() + timeoutMs;

		this.timeout = setTimeout(() => {
			if (!this.stop()) {
				return;
			}
			onExpire();
		}, timeoutMs);
		this.refreshTimer = setInterval(() => {
			if (!this.stopped) {
				onTick();
			}
		}, countdownTickMs);
	}

	stop(): boolean {
		if (this.stopped) {
			return false;
		}
		this.stopped = true;
		if (this.timeout) {
			clearTimeout(this.timeout);
			this.timeout = undefined;
		}
		if (this.refreshTimer) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = undefined;
		}
		return true;
	}

	getRemainingMs(): number {
		return Math.max(0, this.deadlineMs - this.now());
	}
}

export function formatCountdownLabel(remainingMs: number): string {
	if (remainingMs >= 10_000) {
		return `${Math.ceil(remainingMs / 1000)}s`;
	}
	return `${(Math.ceil(remainingMs / 100) / 10).toFixed(1)}s`;
}
