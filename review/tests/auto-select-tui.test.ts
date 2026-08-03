import { afterEach, describe, expect, test, vi } from "vitest";
import { runReviewAutoSelect, type ReviewAutoSelectTimingOptions } from "../auto-select-tui";

const ESCAPE = "\u001b";
const DOWN = "\u001b[B";
const ENTER = "\r";

afterEach(() => {
	vi.useRealTimers();
});

async function runAutoSelect(options: {
	drive: (component: any) => Promise<void> | void;
	timing?: ReviewAutoSelectTimingOptions;
}): Promise<string | undefined> {
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			custom: async (render: any) => {
				return await new Promise<string | undefined>((resolve, reject) => {
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

	return runReviewAutoSelect(
		ctx,
		"Start review in:",
		[
			{ value: "empty", label: "Empty branch" },
			{ value: "current", label: "Current branch" },
		],
		"empty",
		options.timing,
	);
}

describe("runReviewAutoSelect", () => {
	test("automatically selects the configured option after five seconds", async () => {
		vi.useFakeTimers();
		let rendered = "";
		const result = await runAutoSelect({
			timing: { timeoutMs: 30, countdownTickMs: 5 },
			drive: async (component) => {
				rendered = component.render(100).join("\n");
				await vi.advanceTimersByTimeAsync(60);
			},
		});

		expect(rendered).toContain("Selecting Empty branch");
		expect(rendered).toContain("Press any key to choose manually.");
		expect(result).toBe("empty");
	});

	test("any keyboard input interrupts the timer and allows manual selection", async () => {
		vi.useFakeTimers();
		const result = await runAutoSelect({
			timing: { timeoutMs: 30, countdownTickMs: 5 },
			drive: async (component) => {
				component.handleInput(DOWN);
				await vi.advanceTimersByTimeAsync(60);
				component.handleInput(ENTER);
			},
		});

		expect(result).toBe("current");
	});

	test("escape interrupts automatic selection and cancels", async () => {
		const result = await runAutoSelect({
			timing: { timeoutMs: 30, countdownTickMs: 5 },
			drive: (component) => component.handleInput(ESCAPE),
		});

		expect(result).toBeUndefined();
	});
});
