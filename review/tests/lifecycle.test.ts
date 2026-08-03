import { describe, expect, test } from "vitest";
import { ReviewLifecycleController } from "../lifecycle";

describe("ReviewLifecycleController", () => {
	test("requires a matching started review agent before automatic exit", () => {
		const lifecycle = new ReviewLifecycleController();
		lifecycle.setPhase("reviewing", "run-1");

		expect(lifecycle.beginAutoExit("run-1")).toBe(false);
		lifecycle.markAgentStarted("run-1");
		expect(lifecycle.beginAutoExit("run-other")).toBe(false);
		expect(lifecycle.beginAutoExit("run-1")).toBe(true);
		expect(lifecycle.getState()).toEqual({ phase: "awaiting-exit", runId: "run-1" });
	});

	test("requires another agent run after automatic exit is cancelled", () => {
		const lifecycle = new ReviewLifecycleController();
		lifecycle.markAgentStarted("run-1");
		expect(lifecycle.beginAutoExit("run-1")).toBe(true);
		lifecycle.setPhase("reviewing", "run-1");

		expect(lifecycle.getState()).toEqual({
			phase: "reviewing",
			runId: "run-1",
			agentInFlight: false,
		});
		expect(lifecycle.beginAutoExit("run-1")).toBe(false);
	});

	test("restores active and inactive sessions without assuming an agent is running", () => {
		const lifecycle = new ReviewLifecycleController();
		lifecycle.restore(true, "run-1");
		expect(lifecycle.getState()).toEqual({
			phase: "reviewing",
			runId: "run-1",
			agentInFlight: false,
		});

		lifecycle.restore(false);
		expect(lifecycle.getState()).toEqual({ phase: "inactive" });
	});
});
