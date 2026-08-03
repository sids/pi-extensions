import { afterEach, describe, expect, test, vi } from "vitest";
import {
	applyPriorityShortcut,
	buildReviewTriageResult,
	createInitialTriageComments,
	normalizeReviewerNote,
	resolvePriorityShortcutInput,
	runReviewTriageWithCountdown,
	type ReviewTriageTimingOptions,
} from "../triage-tui";

const CTRL_C = "\u0003";

afterEach(() => {
	vi.useRealTimers();
});

async function runAutomaticTriage(options: {
	drive: (component: any) => Promise<void> | void;
	onRenderRequest?: () => void;
	timing?: ReviewTriageTimingOptions;
}) {
	const comments = [{
		version: 1 as const,
		id: "c1",
		runId: "run-1",
		priority: "P2" as const,
		comment: "Issue",
		references: [],
		createdAt: 1,
	}];
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			custom: async (factory: any) => {
				return await new Promise((resolve, reject) => {
					let component: any;
					const done = (result: unknown) => {
						component?.dispose?.();
						resolve(result);
					};
					component = factory(
						{ requestRender: () => options.onRenderRequest?.(), terminal: { rows: 24, columns: 120 } },
						{
							fg: (_token: string, text: string) => text,
							bold: (text: string) => text,
						},
						undefined,
						done,
					);
					void Promise.resolve(options.drive(component)).catch(reject);
				});
			},
		},
	} as any;
	return runReviewTriageWithCountdown(ctx, comments, "current changes", options.timing);
}

describe("createInitialTriageComments", () => {
	test("marks all comments kept by default", () => {
		const triage = createInitialTriageComments([
			{
				version: 1,
				id: "c1",
				runId: "run-1",
				priority: "P2",
				comment: "Issue",
				references: [],
				createdAt: 1,
			},
		]);

		expect(triage).toEqual([
			{
				id: "c1",
				keep: true,
				priority: "P2",
				comment: "Issue",
				references: [],
				originalPriority: "P2",
				note: "",
			},
		]);
	});
});

describe("applyPriorityShortcut", () => {
	test("maps shortcuts 0-3", () => {
		expect(applyPriorityShortcut("0", "P3")).toBe("P0");
		expect(applyPriorityShortcut("1", "P3")).toBe("P1");
		expect(applyPriorityShortcut("2", "P1")).toBe("P2");
		expect(applyPriorityShortcut("3", "P0")).toBe("P3");
		expect(applyPriorityShortcut("9", "P1")).toBe("P1");
	});
});

describe("resolvePriorityShortcutInput", () => {
	test("supports caret shortcuts", () => {
		expect(resolvePriorityShortcutInput("^0")).toBe("P0");
		expect(resolvePriorityShortcutInput("^1")).toBe("P1");
		expect(resolvePriorityShortcutInput("^2")).toBe("P2");
		expect(resolvePriorityShortcutInput("^3")).toBe("P3");
		expect(resolvePriorityShortcutInput("1")).toBeUndefined();
	});

	test("supports terminal control-sequence shortcuts", () => {
		expect(resolvePriorityShortcutInput("\u001b[48;5u")).toBe("P0");
		expect(resolvePriorityShortcutInput("\u001b[49;5u")).toBe("P1");
		expect(resolvePriorityShortcutInput("\u001b[27;5;50~")).toBe("P2");
		expect(resolvePriorityShortcutInput("\u001b[27;5;51~")).toBe("P3");
		expect(resolvePriorityShortcutInput("\u001b[27;5;99~")).toBeUndefined();
	});
});

describe("normalizeReviewerNote", () => {
	test("returns undefined for empty note", () => {
		expect(normalizeReviewerNote("   ")).toBeUndefined();
	});
});

describe("runReviewTriageWithCountdown", () => {
	test("shows triage and accepts all comments when the timer expires", async () => {
		vi.useFakeTimers();
		let rendered = "";
		const result = await runAutomaticTriage({
			timing: { timeoutMs: 30, countdownTickMs: 5 },
			drive: async (component) => {
				rendered = component.render(120).join("\n");
				await vi.advanceTimersByTimeAsync(60);
			},
		});

		expect(rendered).toContain("Review Triage · Target: current changes");
		expect(rendered).toContain("Accepting all comments and returning in");
		expect(result?.keptCount).toBe(1);
		expect(result?.comments[0].keep).toBe(true);
	});

	test("any key pauses auto-accept and leaves triage interactive", async () => {
		vi.useFakeTimers();
		let renderRequests = 0;
		let renderedAfterInput = "";
		const result = await runAutomaticTriage({
			onRenderRequest: () => {
				renderRequests += 1;
			},
			timing: { timeoutMs: 30, countdownTickMs: 5 },
			drive: async (component) => {
				component.handleInput("^2");
				renderedAfterInput = component.render(120).join("\n");
				await vi.advanceTimersByTimeAsync(60);
				component.handleInput(CTRL_C);
			},
		});

		expect(renderedAfterInput).toContain("Automatic acceptance paused. Triage comments manually.");
		expect(renderRequests).toBeGreaterThan(0);
		expect(result).toBeNull();
	});
});

describe("buildReviewTriageResult", () => {
	test("calculates kept/discarded counts and trims notes", () => {
		const result = buildReviewTriageResult([
			{
				id: "c1",
				keep: true,
				priority: "P1",
				comment: "kept",
				references: [],
				note: "  important  ",
				originalPriority: "P1",
			},
			{
				id: "c2",
				keep: false,
				priority: "P3",
				comment: "discard",
				references: [],
				note: "  ",
				originalPriority: "P3",
			},
		]);

		expect(result.keptCount).toBe(1);
		expect(result.discardedCount).toBe(1);
		expect(result.comments[0].note).toBe("important");
		expect(result.comments[1].note).toBeUndefined();
	});
});
