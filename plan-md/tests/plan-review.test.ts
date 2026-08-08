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
		const calls: string[] = [];
		const result = await reviewPlanInBrowser(
			createContext(),
			"# Plan\n\n- Step one",
			async (_ctx, plan) => {
				calls.push(plan);
				return { approved: false, feedback: "Add tests" };
			},
		);

		expect(calls).toEqual(["# Plan\n\n- Step one"]);
		expect(result).toEqual({ approved: false, feedback: "Add tests" });
	});

	test("adds context to startup errors", async () => {
		await expect(
			reviewPlanInBrowser(
				createContext(),
				"# Plan",
				async () => {
					throw new Error("browser unavailable");
				},
			),
		).rejects.toThrow("Failed to open plan review: browser unavailable");
	});
});
