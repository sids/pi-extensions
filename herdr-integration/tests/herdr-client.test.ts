import { describe, expect, test, vi } from "vitest";
import { createHerdrReporter, type HerdrRequest } from "../herdr-client";

const ENV = {
	HERDR_ENV: "1",
	HERDR_SOCKET_PATH: "/tmp/herdr.sock",
	HERDR_PANE_ID: "w1:p1",
};

function context(sessionFile: string | undefined, sessionId = "session-1") {
	return {
		sessionManager: {
			getSessionFile: () => sessionFile,
			getSessionId: () => sessionId,
		},
	} as any;
}

describe("Herdr reporter", () => {
	test("reports session identity and state with ordered sequence numbers", async () => {
		const requests: HerdrRequest[] = [];
		const reporter = createHerdrReporter(ENV, async (request) => {
			requests.push(request);
		});
		const ctx = context("/tmp/session.jsonl");

		await reporter.reportSession(ctx, "startup");
		reporter.reportState("working", undefined, ctx);
		await vi.waitFor(() => expect(requests).toHaveLength(2));

		expect(requests[0]).toMatchObject({
			method: "pane.report_agent_session",
			params: {
				pane_id: "w1:p1",
				source: "herdr:pi",
				agent: "pi",
				session_start_source: "startup",
				agent_session_path: "/tmp/session.jsonl",
			},
		});
		expect(requests[1]).toMatchObject({
			method: "pane.report_agent",
			params: {
				pane_id: "w1:p1",
				source: "herdr:pi",
				agent: "pi",
				state: "working",
				agent_session_path: "/tmp/session.jsonl",
			},
		});
		expect(requests[1].params.seq as number).toBeGreaterThan(requests[0].params.seq as number);
	});

	test("falls back to the session id and skips unreferenced sessions", async () => {
		const requests: HerdrRequest[] = [];
		const reporter = createHerdrReporter(ENV, async (request) => {
			requests.push(request);
		});

		await reporter.reportSession(context(undefined, "session-1"));
		await reporter.reportSession(context(undefined, ""));

		expect(requests).toHaveLength(1);
		expect(requests[0].params).toMatchObject({ agent_session_id: "session-1" });
	});

	test("coalesces pending state while preserving the in-flight report", async () => {
		const requests: HerdrRequest[] = [];
		let releaseFirst: (() => void) | undefined;
		const firstDelivery = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const reporter = createHerdrReporter(ENV, async (request) => {
			requests.push(request);
			if (requests.length === 1) {
				await firstDelivery;
			}
		});
		const ctx = context("/tmp/session.jsonl");

		reporter.reportState("working", undefined, ctx);
		reporter.reportState("idle", undefined, ctx);
		reporter.reportState("blocked", "input needed", ctx);
		expect(requests).toHaveLength(1);

		releaseFirst?.();
		await vi.waitFor(() => expect(requests).toHaveLength(2));

		expect(requests.map((request) => request.params.state)).toEqual(["working", "blocked"]);
		expect(requests[1].params.message).toBe("input needed");
	});
});
