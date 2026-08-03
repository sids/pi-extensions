import { afterEach, describe, expect, test, vi } from "vitest";
import {
	runReviewPromptCountdown,
	type ReviewPromptCountdownDecision,
	type ReviewPromptCountdownTimingOptions,
} from "../prompt-tui";

const ESCAPE = "\u001b";
const CTRL_C = "\u0003";

afterEach(() => {
	vi.useRealTimers();
});

async function runPromptCountdown(options: {
	drive: (component: any) => Promise<void> | void;
	timing?: ReviewPromptCountdownTimingOptions;
}): Promise<ReviewPromptCountdownDecision> {
	const ctx = {
		hasUI: true,
		cwd: "/tmp/project",
		ui: {
			custom: async (render: any) => {
				return await new Promise<ReviewPromptCountdownDecision>((resolve, reject) => {
					const component = render(
						{ requestRender: () => {} },
						{
							fg: (_token: string, text: string) => text,
							bold: (text: string) => text,
						},
						undefined,
						resolve,
					);
					void (async () => {
						try {
							await options.drive(component);
						} catch (error) {
							reject(error);
						}
					})();
				});
			},
		},
	} as any;

	return runReviewPromptCountdown(ctx, "Review current changes", "Start review", options.timing);
}

describe("runReviewPromptCountdown", () => {
	test("shows the prompt with a 10 second countdown", async () => {
		let rendered = "";
		const result = await runPromptCountdown({
			timing: { now: () => 1000 },
			drive: (component) => {
				rendered = component.render(120).join("\n");
				component.handleInput(ESCAPE);
			},
		});

		expect(rendered).toContain("Start review");
		expect(rendered).toContain("Submitting in 10s. Press Esc to edit instead.");
		expect(rendered).toContain("Review current changes");
		expect(result).toBe("edit");
	});

	test("auto-submits when the timer expires", async () => {
		vi.useFakeTimers();
		const result = await runPromptCountdown({
			timing: { timeoutMs: 30, countdownTickMs: 5 },
			drive: async () => {
				await vi.advanceTimersByTimeAsync(60);
			},
		});

		expect(result).toBe("submit");
	});

	test("ignores regular input while auto-submit is active", async () => {
		vi.useFakeTimers();
		const result = await runPromptCountdown({
			timing: { timeoutMs: 30, countdownTickMs: 5 },
			drive: async (component) => {
				component.handleInput("x");
				await vi.advanceTimersByTimeAsync(60);
			},
		});

		expect(result).toBe("submit");
	});

	test("uses Ctrl+C to stop auto-submit", async () => {
		vi.useFakeTimers();
		const result = await runPromptCountdown({
			timing: { timeoutMs: 30, countdownTickMs: 5 },
			drive: (component) => {
				component.handleInput(CTRL_C);
			},
		});
		await vi.advanceTimersByTimeAsync(60);

		expect(result).toBe("edit");
	});
});
