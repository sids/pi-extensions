import { describe, expect, test } from "bun:test";
import {
	buildSubagentLaunchReviewResult,
	buildSubagentModelOptions,
	buildSubagentThinkingOptions,
	createInitialReviewedSubagentTasks,
	normalizeSubagentCancellationNote,
	parseSubagentScopedModelPatterns,
	resolveConfiguredSubagentModelPatterns,
} from "../launch-tui";

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
				launchStatus: "ready",
				cancellationNote: undefined,
			},
			{
				taskId: "task-b",
				prompt: "Inspect B",
				cwd: "/tmp/custom",
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
				launchStatus: "ready",
				cancellationNote: "should be dropped",
			},
			{
				taskId: "task-b",
				prompt: "Inspect B",
				cwd: "/tmp/project",
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
