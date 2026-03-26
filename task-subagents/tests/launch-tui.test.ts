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
		const previousArgv = process.argv;
		process.argv = ["bun", "test", "--models", ""];

		try {
			const result = await runSubagentLaunchReview(
				{
					hasUI: true,
					cwd: "/tmp/project",
					modelRegistry: {
						getAvailable: () => [],
						find: () => undefined,
					},
					ui: {
						custom: async (render: any) => {
							return await new Promise<ReviewedSubagentTask[] | null>((resolve) => {
								const component = render(
									{ requestRender: () => {} },
									{
										fg: (_token: string, text: string) => text,
										bold: (text: string) => text,
									},
									undefined,
									resolve,
								);
								component.handleInput("\u001b[Z");
								component.handleInput("\r");
								component.handleInput("\r");
							});
						},
					},
				} as any,
				[
					{
						taskId: "task-a",
						prompt: "Inspect A",
						cwd: "/tmp/project",
						defaultThinking: undefined,
						launchContext: "fresh",
						launchStatus: "ready",
						cancellationNote: undefined,
					},
				],
				{
					currentThinkingLevel: "medium",
				},
			);

			expect(result?.[0]?.thinkingOverride).toBe("high");
		} finally {
			process.argv = previousArgv;
		}
	});

	test("appends late tasks into the live review state", async () => {
		const previousArgv = process.argv;
		process.argv = ["bun", "test", "--models", ""];
		const initialTasks: ReviewedSubagentTask[] = [
			{
				taskId: "task-a",
				prompt: "Inspect A",
				cwd: "/tmp/project",
				defaultThinking: undefined,
				launchContext: "fresh",
				launchStatus: "ready",
				cancellationNote: undefined,
			},
		];
		const lateTask: ReviewedSubagentTask = {
			taskId: "task-b",
			prompt: "Inspect B",
			cwd: "/tmp/project",
			defaultThinking: undefined,
			launchContext: "fresh",
			launchStatus: "ready",
			cancellationNote: undefined,
		};
		let reviewHandle:
			| {
					appendTasks: (tasks: ReviewedSubagentTask[]) => void;
			  }
			| undefined;

		try {
			const result = await runSubagentLaunchReview(
				{
					hasUI: true,
					cwd: "/tmp/project",
					modelRegistry: {
						getAvailable: () => [],
						find: () => undefined,
					},
					ui: {
						custom: async (render: any) => {
							return await new Promise<ReviewedSubagentTask[] | null>((resolve) => {
								const component = render(
									{ requestRender: () => {} },
									{
										fg: (_token: string, text: string) => text,
										bold: (text: string) => text,
									},
									undefined,
									resolve,
								);
								expect(reviewHandle).toBeDefined();
								reviewHandle?.appendTasks([lateTask]);
								resolve(buildSubagentLaunchReviewResult((component as any).tasks).tasks);
							});
						},
					},
				} as any,
				initialTasks,
				{
					onReady: (handle) => {
						reviewHandle = handle;
					},
				},
			);

			expect(initialTasks).toHaveLength(1);
			expect(result).toEqual([
				{
					taskId: "task-a",
					prompt: "Inspect A",
					cwd: "/tmp/project",
					defaultThinking: undefined,
					launchContext: "fresh",
					launchStatus: "ready",
					cancellationNote: undefined,
				},
				{
					taskId: "task-b",
					prompt: "Inspect B",
					cwd: "/tmp/project",
					defaultThinking: undefined,
					launchContext: "fresh",
					launchStatus: "ready",
					cancellationNote: undefined,
				},
			]);
		} finally {
			process.argv = previousArgv;
		}
	});
});
