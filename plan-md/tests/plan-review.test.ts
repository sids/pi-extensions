import { describe, expect, test } from "vitest";
import { reviewPlanInBrowser } from "../plan-review";

function createContext() {
	return {
		hasUI: true,
		ui: {
			notify() {},
			theme: {
				fg: (_color: string, text: string) => text,
				underline: (text: string) => text,
			},
		},
	} as any;
}

describe("reviewPlanInBrowser", () => {
	test("returns the Plannotator decision", async () => {
		const calls: Array<{ plan: string; signal?: AbortSignal }> = [];
		const signal = new AbortController().signal;
		const result = await reviewPlanInBrowser(
			createContext(),
			"# Plan\n\n- Step one",
			signal,
			async (_ctx, plan, receivedSignal) => {
				calls.push({ plan, signal: receivedSignal });
				return { approved: false, feedback: "Add tests" };
			},
		);

		expect(calls).toEqual([{ plan: "# Plan\n\n- Step one", signal }]);
		expect(result).toEqual({ approved: false, feedback: "Add tests" });
	});

	test("adds context to startup errors", async () => {
		await expect(
			reviewPlanInBrowser(
				createContext(),
				"# Plan",
				undefined,
				async () => {
					throw new Error("browser unavailable");
				},
			),
		).rejects.toThrow("Failed to open plan review: browser unavailable");
	});
});
