import { describe, expect, test } from "bun:test";
import {
	buildSubagentContextOptions,
	buildSubagentLaunchReviewResult,
	buildSubagentModelOptions,
	buildSubagentThinkingOptions,
	createInitialReviewedSubagentTasks,
	normalizeSubagentCancellationNote,
	parseSubagentScopedModelPatterns,
	resolveConfiguredSubagentModelPatterns,
	runSubagentLaunchReview,
} from "../launch-tui";
import type { ReviewedSubagentTask } from "../types";

const ENTER = "\r";
const SHIFT_TAB = "\u001b[Z";
const ESCAPE = "\u001b";
const CTRL_C = "\u0003";

type LaunchReviewDefaults = NonNullable<Parameters<typeof runSubagentLaunchReview>[2]>;

function createReviewedTask(overrides: Partial<ReviewedSubagentTask> = {}): ReviewedSubagentTask {
	return {
		taskId: "task-a",
		prompt: "Inspect A",
		cwd: "/tmp/project",
		defaultThinking: undefined,
		launchContext: "fresh",
		launchStatus: "ready",
		cancellationNote: undefined,
		...overrides,
	};
}

function createLaunchReviewContext(customHandler: (render: any) => Promise<any>) {
	return {
		hasUI: true,
		cwd: "/tmp/project",
		modelRegistry: {
			getAvailable: () => [],
			find: () => undefined,
		},
		ui: {
			custom: async (render: any) => {
				return await customHandler(render);
			},
		},
	} as any;
}

async function withEmptyModelScope<T>(run: () => Promise<T>): Promise<T> {
	const previousArgv = process.argv;
	process.argv = ["bun", "test", "--models", ""];

	try {
		return await run();
	} finally {
		process.argv = previousArgv;
	}
}

async function runInteractiveLaunchReview(options: {
	drive: (component: any) => Promise<void> | void;
	tasks?: ReviewedSubagentTask[];
	defaults?: LaunchReviewDefaults;
	requestRender?: () => void;
	theme?: {
		fg?: (token: string, text: string) => string;
		bold?: (text: string) => string;
	};
}): Promise<ReviewedSubagentTask[] | null> {
	return await withEmptyModelScope(async () => {
		return await runSubagentLaunchReview(
			createLaunchReviewContext(async (render) => {
				return await new Promise<ReviewedSubagentTask[] | null>((resolve, reject) => {
					const component = render(
						{ requestRender: options.requestRender ?? (() => {}), terminal: { rows: 24 } },
						{
							fg: options.theme?.fg ?? ((_token: string, text: string) => text),
							bold: options.theme?.bold ?? ((text: string) => text),
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
			}),
			options.tasks ?? [createReviewedTask()],
			options.defaults,
		);
	});
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("createInitialReviewedSubagentTasks", () => {
	test("resolves cwd and defaults tasks to ready", () => {
		const reviewed = createInitialReviewedSubagentTasks(
			[
				{ id: "task-a", prompt: "Inspect A" },
				{ id: "task-b", prompt: "Inspect B", cwd: "/tmp/custom" },
			],
			"/tmp/default",
		);

		expect(reviewed).toEqual([
			{
				taskId: "task-a",
				prompt: "Inspect A",
				cwd: "/tmp/default",
				defaultThinking: undefined,
				launchContext: "fresh",
				launchStatus: "ready",
				cancellationNote: undefined,
			},
			{
				taskId: "task-b",
				prompt: "Inspect B",
				cwd: "/tmp/custom",
				defaultThinking: undefined,
				launchContext: "fresh",
				launchStatus: "ready",
				cancellationNote: undefined,
			},
		]);
	});
});

describe("normalizeSubagentCancellationNote", () => {
	test("returns undefined for blank notes", () => {
		expect(normalizeSubagentCancellationNote("   ")).toBeUndefined();
	});
});

describe("buildSubagentModelOptions", () => {
	test("prepends inherit and de-duplicates provider/id pairs", () => {
		const options = buildSubagentModelOptions(
			[
				{ provider: "openai", id: "gpt-5", name: "GPT-5" },
				{ provider: "openai", id: "gpt-5", name: "GPT-5 duplicate" },
				{ provider: "anthropic", id: "claude-sonnet", name: "Claude Sonnet" },
			],
			"openai/gpt-5",
		);

		expect(options).toEqual([
			{
				label: "openai/gpt-5 (current)",
				description: "Use the main agent's current model.",
			},
			{
				value: "openai/gpt-5",
				label: "openai/gpt-5",
				description: "GPT-5",
			},
			{
				value: "anthropic/claude-sonnet",
				label: "anthropic/claude-sonnet",
				description: "Claude Sonnet",
			},
		]);
	});
});

describe("buildSubagentThinkingOptions", () => {
	test("includes inherit plus the fixed thinking levels", () => {
		const options = buildSubagentThinkingOptions("medium");
		expect(options[0]).toEqual({
			label: "medium (current)",
			description: "Use the main agent's current thinking level.",
		});
		expect(options.map((option) => option.value)).toEqual([
			undefined,
			"off",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
		]);
	});

	test("labels requested launch defaults distinctly from current thinking", () => {
		const options = buildSubagentThinkingOptions("high", { inheritedFromCurrent: false });
		expect(options[0]).toEqual({
			label: "high (default)",
			description: "Use the requested subagent thinking level.",
		});
	});
});

describe("buildSubagentContextOptions", () => {
	test("describes fresh and fork launch modes", () => {
		expect(buildSubagentContextOptions(true)).toEqual([
			{
				value: "fresh",
				label: "fresh",
				description: "Start each subagent in a fresh ephemeral session.",
			},
			{
				value: "fork",
				label: "fork",
				description: "Fork each subagent from the current session.",
				disabled: false,
			},
		]);
		expect(buildSubagentContextOptions(false)[1]).toEqual({
			value: "fork",
			label: "fork",
			description: "Fork each subagent from the current session. Unavailable until the current session is saved.",
			disabled: true,
		});
	});
});

describe("parseSubagentScopedModelPatterns", () => {
	test("extracts --models values from argv", () => {
		expect(parseSubagentScopedModelPatterns(["--models", "openai/gpt-5, anthropic/claude-sonnet "])).toEqual([
			"openai/gpt-5",
			"anthropic/claude-sonnet",
		]);
		expect(parseSubagentScopedModelPatterns(["--print"])).toBeUndefined();
	});
});

describe("resolveConfiguredSubagentModelPatterns", () => {
	test("uses project enabledModels over global settings", () => {
		expect(
			resolveConfiguredSubagentModelPatterns(
				{ enabledModels: ["openai/gpt-5"] },
				{ enabledModels: ["anthropic/claude-sonnet"] },
			),
		).toEqual(["anthropic/claude-sonnet"]);
		expect(resolveConfiguredSubagentModelPatterns({ enabledModels: ["openai/gpt-5"] }, null)).toEqual([
			"openai/gpt-5",
		]);
	});
});

describe("buildSubagentLaunchReviewResult", () => {
	test("counts ready and cancelled tasks while trimming cancellation notes", () => {
		const result = buildSubagentLaunchReviewResult([
			{
				taskId: "task-a",
				prompt: "Inspect A",
				cwd: "/tmp/project",
				defaultThinking: undefined,
				launchContext: "fresh",
				launchStatus: "ready",
				cancellationNote: "should be dropped",
			},
			{
				taskId: "task-b",
				prompt: "Inspect B",
				cwd: "/tmp/project",
				defaultThinking: undefined,
				launchContext: "fork",
				launchStatus: "cancelled",
				cancellationNote: "  Already covered  ",
			},
		]);
		expect(result.readyCount).toBe(1);
		expect(result.cancelledCount).toBe(1);
		expect(result.tasks[0]?.cancellationNote).toBeUndefined();
		expect(result.tasks[1]?.cancellationNote).toBe("Already covered");
	});
});

describe("runSubagentLaunchReview", () => {
	test("cycles thinking from the currently selected effective value", async () => {
		const result = await runInteractiveLaunchReview({
			drive: (component) => {
				component.handleInput(SHIFT_TAB);
				component.handleInput(ENTER);
				component.handleInput(ENTER);
			},
			defaults: {
				currentThinkingLevel: "medium",
			},
		});

		expect(result?.[0]?.thinkingOverride).toBe("high");
	});

	test("appends late tasks into the live review state", async () => {
		const initialTasks = [createReviewedTask()];
		const lateTask = createReviewedTask({ taskId: "task-b", prompt: "Inspect B" });
		let reviewHandle:
			| {
					appendTasks: (tasks: ReviewedSubagentTask[]) => void;
			  }
			| undefined;

		const result = await runInteractiveLaunchReview({
			tasks: initialTasks,
			defaults: {
				onReady: (handle) => {
					reviewHandle = handle;
				},
			},
			drive: (component) => {
				expect(reviewHandle).toBeDefined();
				reviewHandle?.appendTasks([lateTask]);
				component.handleInput(ENTER);
				component.handleInput(ENTER);
				component.handleInput(ENTER);
			},
		});

		expect(initialTasks).toHaveLength(1);
		expect(result).toEqual([
			createReviewedTask(),
			createReviewedTask({ taskId: "task-b", prompt: "Inspect B" }),
		]);
	});

	test("renders countdown text on the review screen", async () => {
		let reviewText = "";

		const result = await runInteractiveLaunchReview({
			defaults: {
				timing: {
					confirmationTimeoutMs: 50,
					countdownTickMs: 10,
					now: () => 1000,
				},
			},
			theme: {
				fg: (token, text) => {
					if (token === "accent") {
						return `<accent>${text}</accent>`;
					}
					if (token === "warning") {
						return `<warning>${text}</warning>`;
					}
					return text;
				},
			},
			drive: (component) => {
				reviewText = component.render(180).join("\n");
				component.handleInput(ESCAPE);
				component.handleInput(ENTER);
				component.handleInput(ENTER);
			},
		});

		expect(reviewText).toContain("<warning>Auto-launching in </warning><accent>0.1s</accent><warning>. Any interaction stops the countdown.</warning>");
		expect(reviewText).toContain("Esc stop countdown");
		expect(result).toEqual([createReviewedTask()]);
	});

	test("auto-confirms after the timeout expires", async () => {
		const result = await runInteractiveLaunchReview({
			defaults: {
				timing: {
					confirmationTimeoutMs: 40,
					countdownTickMs: 10,
				},
			},
			drive: async () => {
				await delay(80);
			},
		});

		expect(result).toEqual([createReviewedTask()]);
	});

	test("cancels the countdown after review interactions", async () => {
		let pausedText = "";
		let settled = false;

		const reviewPromise = runInteractiveLaunchReview({
			defaults: {
				timing: {
					confirmationTimeoutMs: 40,
					countdownTickMs: 10,
				},
			},
			drive: async (component) => {
				component.handleInput("x");
				pausedText = component.render(180).join("\n");
				await delay(80);
				expect(settled).toBe(false);
				component.handleInput(ENTER);
				component.handleInput(ENTER);
			},
		}).finally(() => {
			settled = true;
		});

		const result = await reviewPromise;
		expect(pausedText).toContain("Auto-launch countdown stopped. Continue reviewing or press Enter on the last task to launch.");
		expect(result).toEqual([createReviewedTask({ prompt: "Inspect Ax" })]);
	});

	test("uses Esc to stop only the countdown", async () => {
		let pausedText = "";
		let settled = false;

		const reviewPromise = runInteractiveLaunchReview({
			defaults: {
				timing: {
					confirmationTimeoutMs: 40,
					countdownTickMs: 10,
				},
			},
			theme: {
				fg: (token, text) => (token === "warning" ? `<warning>${text}</warning>` : text),
			},
			drive: async (component) => {
				component.handleInput(ESCAPE);
				pausedText = component.render(180).join("\n");
				await delay(80);
				expect(settled).toBe(false);
				component.handleInput(ENTER);
				component.handleInput(ENTER);
			},
		}).finally(() => {
			settled = true;
		});

		const result = await reviewPromise;
		expect(pausedText).toContain("Auto-launch countdown stopped. Continue reviewing or press Enter on the last task to launch.");
		expect(pausedText).not.toContain("<warning>Auto-launch countdown stopped.");
		expect(result).toEqual([createReviewedTask()]);
	});

	test("uses Esc to leave the confirmation screen and return to editing", async () => {
		let confirmationText = "";
		let reviewText = "";

		const result = await runInteractiveLaunchReview({
			defaults: {
				timing: {
					confirmationTimeoutMs: 40,
					countdownTickMs: 10,
				},
			},
			drive: (component) => {
				component.handleInput(ESCAPE);
				component.handleInput(ENTER);
				confirmationText = component.render(180).join("\n");
				component.handleInput(ESCAPE);
				reviewText = component.render(180).join("\n");
				component.handleInput(ENTER);
				component.handleInput(ENTER);
			},
		});

		expect(confirmationText).toContain("Confirm subagent launch");
		expect(confirmationText).not.toContain("Auto-launching in");
		expect(reviewText).toContain("Subagent launch review");
		expect(reviewText).not.toContain("Auto-launching in");
		expect(result).toEqual([createReviewedTask()]);
	});

	test("uses Ctrl+C to cancel the review", async () => {
		const result = await runInteractiveLaunchReview({
			defaults: {
				timing: {
					confirmationTimeoutMs: 40,
					countdownTickMs: 10,
				},
			},
			drive: (component) => {
				component.handleInput(CTRL_C);
			},
		});

		expect(result).toBeNull();
	});

	test("resets the countdown when late tasks are appended", async () => {
		const lateTask = createReviewedTask({ taskId: "task-b", prompt: "Inspect B" });
		let reviewHandle:
			| {
					appendTasks: (tasks: ReviewedSubagentTask[]) => void;
			  }
			| undefined;
		let updatedReviewText = "";
		let settled = false;

		const reviewPromise = runInteractiveLaunchReview({
			tasks: [createReviewedTask()],
			defaults: {
				onReady: (handle) => {
					reviewHandle = handle;
				},
				timing: {
					confirmationTimeoutMs: 50,
					countdownTickMs: 10,
				},
			},
			drive: async (component) => {
				await delay(25);
				reviewHandle?.appendTasks([lateTask]);
				updatedReviewText = component.render(180).join("\n");
				await delay(35);
				expect(settled).toBe(false);
				await delay(40);
			},
		}).finally(() => {
			settled = true;
		});

		const result = await reviewPromise;
		expect(updatedReviewText).toContain("Task 1/2");
		expect(updatedReviewText).toContain("Auto-launching in");
		expect(result).toEqual([createReviewedTask(), lateTask]);
	});
});
