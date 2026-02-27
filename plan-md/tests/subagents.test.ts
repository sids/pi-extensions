import { describe, expect, test } from "bun:test";
import { buildSubagentRunDetails, normalizeSubagentTasks } from "../subagents";

describe("normalizeSubagentTasks", () => {
	test("sanitizes and deduplicates task ids", () => {
		const normalized = normalizeSubagentTasks([
			{ id: "Auth Scan", prompt: "Inspect auth" },
			{ id: "Auth Scan", prompt: "Inspect auth tests" },
			{ prompt: "Inspect docs" },
		]);

		expect(normalized.map((task) => task.id)).toEqual(["auth-scan", "auth-scan-2", "task-3"]);
	});
});

describe("buildSubagentRunDetails", () => {
	test("counts successful tasks", () => {
		const details = buildSubagentRunDetails("run-1", [
			{
				taskId: "task-1",
				task: "One",
				cwd: "/tmp",
				output: "ok",
				references: [],
				exitCode: 0,
				stderr: "",
				activities: [],
				startedAt: 1,
				finishedAt: 2,
				steeringNotes: [],
			},
			{
				taskId: "task-2",
				task: "Two",
				cwd: "/tmp",
				output: "",
				references: [],
				exitCode: 1,
				stderr: "failed",
				activities: [],
				startedAt: 1,
				finishedAt: 2,
				steeringNotes: [],
			},
		]);

		expect(details.successCount).toBe(1);
		expect(details.totalCount).toBe(2);
	});
});
