export type ReviewLifecyclePhase = "inactive" | "selecting" | "summarizing" | "reviewing" | "awaiting-exit" | "ending";

export type ReviewLifecycleState =
	| { phase: "inactive" | "selecting" | "summarizing"; runId?: undefined; agentInFlight?: false }
	| { phase: "reviewing"; runId: string; agentInFlight: boolean }
	| { phase: "awaiting-exit" | "ending"; runId: string; agentInFlight?: false };

export class ReviewLifecycleController {
	private state: ReviewLifecycleState = { phase: "inactive" };

	getState(): ReviewLifecycleState {
		return this.state;
	}

	setPhase(phase: ReviewLifecyclePhase, runId?: string): void {
		if (phase === "inactive" || phase === "selecting" || phase === "summarizing") {
			this.state = { phase };
			return;
		}
		if (!runId) {
			this.state = { phase: "inactive" };
			return;
		}
		this.state = phase === "reviewing"
			? { phase, runId, agentInFlight: false }
			: { phase, runId };
	}

	restore(active: boolean, runId?: string): void {
		this.setPhase(active && runId ? "reviewing" : "inactive", runId);
	}

	markAgentStarted(runId: string): void {
		this.state = { phase: "reviewing", runId, agentInFlight: true };
	}

	beginAutoExit(runId: string): boolean {
		if (
			this.state.phase !== "reviewing"
			|| this.state.runId !== runId
			|| !this.state.agentInFlight
		) {
			return false;
		}
		this.state = { phase: "awaiting-exit", runId };
		return true;
	}

	beginEnding(runId: string): void {
		this.state = { phase: "ending", runId };
	}
}
