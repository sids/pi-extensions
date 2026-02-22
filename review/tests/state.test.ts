import { describe, expect, test } from "bun:test";
import { createReviewModeStateManager, getLatestState } from "../state";

describe("getLatestState", () => {
	test("returns inactive state by default", () => {
		const state = getLatestState({
			sessionManager: {
				getEntries: () => [],
			},
		} as any);

		expect(state.active).toBe(false);
		expect(state.version).toBe(1);
	});

	test("prefers latest persisted state", () => {
		const state = getLatestState({
			sessionManager: {
				getEntries: () => [
					{ type: "custom", customType: "review-mode:state", data: { version: 1, active: true, runId: "r1" } },
					{ type: "custom", customType: "review-mode:state", data: { version: 1, active: false } },
				],
			},
		} as any);

		expect(state.active).toBe(false);
	});
});

describe("createReviewModeStateManager", () => {
	function createContext(entries: any[] = [], hasUI: boolean = false) {
		const widgetCalls: Array<{ key: string; widget: unknown; placement: string }> = [];
		return {
			ctx: {
				hasUI,
				ui: {
					setWidget: (key: string, widget: unknown, options: { placement: string }) => {
						widgetCalls.push({ key, widget, placement: options.placement });
					},
				},
				sessionManager: {
					getEntries: () => entries,
				},
			},
			widgetCalls,
		};
	}

	test("adds review tool when review mode starts", () => {
		let activeTools = ["read", "bash"];
		const setActiveToolsCalls: string[][] = [];
		const manager = createReviewModeStateManager({
			appendEntry: () => {},
			getActiveTools: () => activeTools,
			setActiveTools: (nextTools: string[]) => {
				setActiveToolsCalls.push(nextTools);
				activeTools = nextTools;
			},
		} as any);

		const { ctx } = createContext();
		manager.startReviewMode(ctx as any, {
			originLeafId: "leaf-1",
			runId: "run-1",
			targetHint: "current changes",
			reviewInstructionsPrompt: "review instructions",
			originModelProvider: "anthropic",
			originModelId: "claude-sonnet",
			originThinkingLevel: "high",
		});

		expect(setActiveToolsCalls).toEqual([["read", "bash", "add_review_comment"]]);
	});

	test("refresh removes review tool and clears banner when inactive", () => {
		let activeTools = ["read", "add_review_comment"];
		const setActiveToolsCalls: string[][] = [];
		const manager = createReviewModeStateManager({
			appendEntry: () => {},
			getActiveTools: () => activeTools,
			setActiveTools: (nextTools: string[]) => {
				setActiveToolsCalls.push(nextTools);
				activeTools = nextTools;
			},
		} as any);

		const { ctx, widgetCalls } = createContext(
			[{ type: "custom", customType: "review-mode:state", data: { version: 1, active: false } }],
			true,
		);
		manager.refresh(ctx as any);

		expect(setActiveToolsCalls).toEqual([["read"]]);
		expect(widgetCalls.at(-1)).toEqual({
			key: "review-mode-banner",
			widget: undefined,
			placement: "aboveEditor",
		});
	});
});
