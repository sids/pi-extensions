import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import cacheExpiryExtension from "../index";
import { ONE_DAY_CACHE_TTL_MS, ONE_HOUR_CACHE_TTL_MS, SHORT_CACHE_TTL_MS } from "../utils";

type Handler = (event: any, ctx: any) => Promise<void> | void;

function createHarness() {
	const handlers = new Map<string, Handler[]>();
	const eventHandlers = new Map<string, Array<(data: unknown) => void>>();
	const currentWidgets = new Map<string, any>();
	const pi = {
		on(name: string, handler: Handler) {
			const hooks = handlers.get(name) ?? [];
			hooks.push(handler);
			handlers.set(name, hooks);
		},
		events: {
			on(channel: string, handler: (data: unknown) => void) {
				const handlers = eventHandlers.get(channel) ?? [];
				handlers.push(handler);
				eventHandlers.set(channel, handlers);
			},
		},
	} as any;

	cacheExpiryExtension(pi);

	const ctx = {
		cwd: "/work",
		hasUI: true,
		ui: {
			setWidget(key: string, widget: any) {
				if (widget === undefined) {
					currentWidgets.delete(key);
				} else {
					currentWidgets.set(key, widget);
				}
			},
		},
	};

	const emit = async (name: string, event: any = {}) => {
		for (const handler of handlers.get(name) ?? []) {
			await handler(event, ctx);
		}
	};

	return {
		emit,
		emitExtensionEvent(channel: string, data: unknown) {
			for (const handler of eventHandlers.get(channel) ?? []) {
				handler(data);
			}
		},
		async completeTurn(payload: unknown) {
			await emit("turn_start");
			await emit("before_provider_request", { payload });
			await emit("turn_end");
		},
		renderWarning() {
			const widget = currentWidgets.get("cache-expiry-warning");
			if (typeof widget !== "function") {
				return null;
			}
			return widget({}, { fg: (_name: string, text: string) => text }).render(200)[0] ?? null;
		},
	};
}

describe("cache expiry extension", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test("shows a warning after the first configured short-cache request", async () => {
		const harness = createHarness();
		await harness.emit("session_start");
		await harness.completeTurn({ prompt_cache_key: "session-1" });

		await vi.advanceTimersByTimeAsync(SHORT_CACHE_TTL_MS - 1);
		expect(harness.renderWarning()).toBeNull();

		await vi.advanceTimersByTimeAsync(1);
		expect(harness.renderWarning()).toContain("may have expired after 5 minutes");
	});

	test("counts cache inactivity from the provider request", async () => {
		const harness = createHarness();
		await harness.emit("turn_start");
		await harness.emit("before_provider_request", { payload: { prompt_cache_key: "session-1" } });
		await vi.advanceTimersByTimeAsync(4 * 60_000);
		await harness.emit("turn_end");

		await vi.advanceTimersByTimeAsync(60_000 - 1);
		expect(harness.renderWarning()).toBeNull();
		await vi.advanceTimersByTimeAsync(1);
		expect(harness.renderWarning()).toContain("may have expired after 5 minutes");
	});

	test("shows the warning immediately when the cache expires during the turn", async () => {
		const harness = createHarness();
		await harness.emit("turn_start");
		await harness.emit("before_provider_request", { payload: { prompt_cache_key: "session-1" } });
		await vi.advanceTimersByTimeAsync(SHORT_CACHE_TTL_MS);
		await harness.emit("turn_end");

		expect(harness.renderWarning()).toContain("may have expired after 5 minutes");
	});

	test("uses the serialized one-hour long-retention window", async () => {
		const harness = createHarness();
		await harness.completeTurn({
			system: [{ cache_control: { type: "ephemeral", ttl: "1h" } }],
		});

		await vi.advanceTimersByTimeAsync(ONE_HOUR_CACHE_TTL_MS);
		expect(harness.renderWarning()).toContain("may have expired after 1 hour");
	});

	test("uses the serialized 24-hour long-retention window", async () => {
		const harness = createHarness();
		await harness.completeTurn({ prompt_cache_key: "session-1", prompt_cache_retention: "24h" });

		await vi.advanceTimersByTimeAsync(ONE_DAY_CACHE_TTL_MS);
		expect(harness.renderWarning()).toContain("may have expired after 1 day");
	});

	test.each(["before", "after"] as const)(
		"uses reported request retention when openai-params runs %s the cache warning hook",
		async (eventOrder) => {
			const harness = createHarness();
			const reportRetention = () =>
				harness.emitExtensionEvent("pi:prompt-cache-retention", {
					source: "openai-params",
					cwd: "/work",
					cacheTtlMs: ONE_DAY_CACHE_TTL_MS,
					requestStartedAtMs: Date.now(),
				});

			await harness.emit("turn_start");
			if (eventOrder === "before") {
				reportRetention();
			}
			await harness.emit("before_provider_request", { payload: { prompt_cache_key: "session-1" } });
			if (eventOrder === "after") {
				reportRetention();
			}
			await harness.emit("turn_end");

			await vi.advanceTimersByTimeAsync(SHORT_CACHE_TTL_MS);
			expect(harness.renderWarning()).toBeNull();
			await vi.advanceTimersByTimeAsync(ONE_DAY_CACHE_TTL_MS - SHORT_CACHE_TTL_MS);
			expect(harness.renderWarning()).toContain("may have expired after 1 day");
		},
	);

	test("clears the warning and timer when another turn starts", async () => {
		const harness = createHarness();
		await harness.completeTurn({ prompt_cache_key: "session-1" });
		await vi.advanceTimersByTimeAsync(SHORT_CACHE_TTL_MS);
		expect(harness.renderWarning()).not.toBeNull();

		await harness.emit("turn_start");
		expect(harness.renderWarning()).toBeNull();
		await vi.advanceTimersByTimeAsync(SHORT_CACHE_TTL_MS);
		expect(harness.renderWarning()).toBeNull();
	});

	test("does not warn without cache metadata", async () => {
		const harness = createHarness();
		await harness.completeTurn({});

		await vi.advanceTimersByTimeAsync(SHORT_CACHE_TTL_MS);
		expect(harness.renderWarning()).toBeNull();
	});

	test("does not warn when long retention is enabled without a serialized ttl", async () => {
		const harness = createHarness();
		await harness.completeTurn({ options: { cacheRetention: "long" } });

		await vi.advanceTimersByTimeAsync(ONE_DAY_CACHE_TTL_MS);
		expect(harness.renderWarning()).toBeNull();
	});

	test("does not reuse stale cache metadata on a later turn", async () => {
		const harness = createHarness();
		await harness.completeTurn({ prompt_cache_key: "session-1" });
		await harness.completeTurn({});

		await vi.advanceTimersByTimeAsync(SHORT_CACHE_TTL_MS);
		expect(harness.renderWarning()).toBeNull();
	});

	test("updates a model from long to short retention", async () => {
		const harness = createHarness();
		await harness.completeTurn({ prompt_cache_retention: "24h" });
		await harness.completeTurn({ prompt_cache_key: "session-1" });

		await vi.advanceTimersByTimeAsync(SHORT_CACHE_TTL_MS);
		expect(harness.renderWarning()).toContain("may have expired after 5 minutes");
	});

	test("stops warning when caching is explicitly disabled", async () => {
		const harness = createHarness();
		await harness.completeTurn({ prompt_cache_key: "session-1" });
		await harness.completeTurn({ options: { cacheRetention: "none" } });

		await vi.advanceTimersByTimeAsync(SHORT_CACHE_TTL_MS);
		expect(harness.renderWarning()).toBeNull();
	});

	test("ignores provider requests outside an active turn", async () => {
		const harness = createHarness();
		await harness.emit("before_provider_request", { payload: { prompt_cache_retention: "24h" } });
		await harness.completeTurn({ prompt_cache_key: "session-1" });

		await vi.advanceTimersByTimeAsync(SHORT_CACHE_TTL_MS);
		expect(harness.renderWarning()).toContain("may have expired after 5 minutes");
	});

	test("clears the warning when the model changes", async () => {
		const harness = createHarness();
		await harness.completeTurn({ prompt_cache_key: "session-1" });
		await vi.advanceTimersByTimeAsync(SHORT_CACHE_TTL_MS);
		expect(harness.renderWarning()).not.toBeNull();

		await harness.emit("model_select");
		expect(harness.renderWarning()).toBeNull();
	});

	test("cancels the timer during session shutdown", async () => {
		const harness = createHarness();
		await harness.completeTurn({ prompt_cache_key: "session-1" });
		await harness.emit("session_shutdown");

		await vi.advanceTimersByTimeAsync(SHORT_CACHE_TTL_MS);
		expect(harness.renderWarning()).toBeNull();
	});
});
