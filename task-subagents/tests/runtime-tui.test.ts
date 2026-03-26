import { describe, expect, test } from "bun:test";
import { initTheme } from "@mariozechner/pi-coding-agent";
import {
	buildLatestRenderBlock,
	createSubagentInspectorResultComponent,
	SubagentSteeringEditorComponent,
} from "../runtime-tui";
import type { SubagentDashboardRunState } from "../types";

initTheme();

function createRunState(): SubagentDashboardRunState {
	const usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		},
	};
	return {
		runId: "run-1",
		createdAt: 1,
		updatedAt: 1,
		active: false,
		tasks: [
			{
				taskId: "task-a",
				prompt: "Inspect A",
				cwd: "/tmp/a",
				status: "completed",
				launchContext: "fresh",
				latestActivity: "finished",
				activityCount: 2,
				transcript: [
					{
						kind: "assistantMessage",
						timestamp: 16,
						message: {
							role: "assistant",
							api: "openai-responses",
							provider: "openai",
							model: "gpt-5",
							usage,
							stopReason: "stop",
							timestamp: 16,
							content: [{ type: "text", text: "task-a latest summary" }],
						},
					},
				],
				output: "done",
				references: [],
				stderr: "",
				startedAt: 1,
				finishedAt: 2,
				steeringNotes: [],
			},
			{
				taskId: "task-b",
				prompt: "Inspect B",
				cwd: "/tmp/b",
				status: "failed",
				launchContext: "fresh",
				latestActivity: "failed",
				activityCount: 2,
				transcript: [
					{
						kind: "assistantMessage",
						timestamp: 1,
						message: {
							role: "assistant",
							api: "openai-responses",
							provider: "openai",
							model: "gpt-5",
							usage,
							stopReason: "toolUse",
							timestamp: 1,
							content: [{ type: "toolCall", id: "tool-call-1", name: "read", arguments: { path: "README.md" } }],
						},
					},
					{
						kind: "toolResultMessage",
						timestamp: 2,
						message: {
							role: "toolResult",
							toolCallId: "tool-call-1",
							toolName: "read",
							content: [{ type: "text", text: "README contents" }],
							details: { path: "README.md" },
							isError: true,
							timestamp: 2,
						},
					},
				],
				output: "",
				references: [],
				stderr: "boom",
				startedAt: 1,
				finishedAt: 2,
				steeringNotes: [],
			},
			{
				taskId: "task-c",
				prompt: "Inspect C",
				cwd: "/tmp/c",
				status: "running",
				launchContext: "fresh",
				latestActivity: "drafting summary",
				activityCount: 3,
				transcript: [
					{
						kind: "assistantMessage",
						timestamp: 3,
						message: {
							role: "assistant",
							api: "openai-responses",
							provider: "openai",
							model: "gpt-5",
							usage,
							stopReason: "stop",
							timestamp: 3,
							content: [{ type: "text", text: "partial summary from the running task" }],
						},
					},
				],
				output: "",
				references: [],
				stderr: "",
				startedAt: 1,
				finishedAt: null,
				steeringNotes: [],
			},
		],
	};
}

describe("runtime-tui helpers", () => {
	test("buildLatestRenderBlock prefers the latest tool execution block", () => {
		const run = createRunState();
		const block = buildLatestRenderBlock(run.tasks[1]!);
		expect(block).toMatchObject({
			kind: "toolExecution",
			toolName: "read",
		});
	});

	test("renders expanded-style details for the current subagent", () => {
		const run = createRunState();
		let selectedTaskId = "task-a";
		const component = createSubagentInspectorResultComponent({
			runId: "run-1",
			getRunState: () => run,
			getSelectedTaskId: () => selectedTaskId,
			accentColor: (text) => `<accent>${text}</accent>`,
			mutedColor: (text) => `<muted>${text}</muted>`,
			dimColor: (text) => `<dim>${text}</dim>`,
		});

		const taskARender = component.render(100).join("\n");
		expect(taskARender).toContain("<muted>Subagent:</muted> <accent>task-a</accent>");
		expect(taskARender).not.toContain("[ ✓ task-a ]");
		expect(taskARender).toContain("Prompt: Inspect A");
		expect(taskARender).toContain("CWD:");
		expect(taskARender).toContain("Duration:");
		expect(taskARender).toContain("Activity:");
		expect(taskARender).toContain("Output:");
		expect(taskARender).toContain("done");

		selectedTaskId = "task-b";
		const taskBRender = component.render(100).join("\n");
		expect(taskBRender).toContain("<muted>Subagent:</muted> <accent>task-b</accent>");
		expect(taskBRender).toContain("Latest tool call:");
		expect(taskBRender).toContain("read");
		expect(taskBRender).toContain("README.md");

		selectedTaskId = "task-c";
		const taskCRender = component.render(100).join("\n");
		expect(taskCRender).toContain("Latest update:");
		expect(taskCRender).toContain("partial summary from the running task");
		expect(taskCRender).not.toContain("(no output)");
	});
});

describe("SubagentSteeringEditorComponent", () => {
	function createHarness(options?: { submitDraft?: (taskId: string, draft: string) => Promise<void> }) {
		const run = createRunState();
		let selectedTaskId = "task-a";
		const drafts = new Map<string, string>();
		let renderRequests = 0;
		let closed = 0;
		let listener: (() => void) | undefined;
		let statusMessage = "";
		const component = new SubagentSteeringEditorComponent(
			{ requestRender: () => { renderRequests += 1; }, terminal: { rows: 24 } } as any,
			{},
			{
				getRunState: () => run,
				getSelectedTaskId: () => selectedTaskId,
				setSelectedTaskId: (taskId) => { selectedTaskId = taskId; },
				getDraft: (taskId) => drafts.get(taskId) ?? "",
				setDraft: (taskId, draft) => { drafts.set(taskId, draft); },
				submitDraft: options?.submitDraft ?? (async () => {}),
				close: () => { closed += 1; },
				subscribe: (nextListener) => {
					listener = nextListener;
					return () => {
						if (listener === nextListener) {
							listener = undefined;
						}
					};
				},
				getStatusMessage: () => statusMessage || undefined,
			},
		);

		return {
			component,
			render: () => component.render(100).join("\n"),
			setStatusMessage: (value: string) => {
				statusMessage = value;
				listener?.();
			},
			getSelectedTaskId: () => selectedTaskId,
			getDraft: (taskId: string) => drafts.get(taskId),
			getClosed: () => closed,
			getRenderRequests: () => renderRequests,
		};
	}

	test("switches tabs with tab and shift+tab", () => {
		const harness = createHarness();
		for (const char of "first draft") {
			harness.component.handleInput(char);
		}
		harness.component.handleInput("\t");
		expect(harness.getSelectedTaskId()).toBe("task-b");
		harness.component.handleInput("\u001b[Z");
		expect(harness.getSelectedTaskId()).toBe("task-a");
		expect(harness.render()).toContain("first draft");
	});

	test("submits the selected task draft with enter", async () => {
		const calls: Array<{ taskId: string; draft: string }> = [];
		const harness = createHarness({
			submitDraft: async (taskId, draft) => {
				calls.push({ taskId, draft });
			},
		});
		for (const char of "Focus on config") {
			harness.component.handleInput(char);
		}
		harness.component.handleInput("\r");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(calls).toEqual([{ taskId: "task-a", draft: "Focus on config" }]);
	});

	test("closes on escape", () => {
		const harness = createHarness();
		harness.component.handleInput("\u001b");
		expect(harness.getClosed()).toBe(1);
	});

	test("renders tabs above the editor and shows status", () => {
		const harness = createHarness();
		harness.setStatusMessage("Steered task-a.");
		const rendered = harness.render();
		const tabsIndex = rendered.indexOf("task-a");
		const editorBorderIndex = rendered.indexOf("─");
		expect(tabsIndex).toBeGreaterThanOrEqual(0);
		expect(editorBorderIndex).toBeGreaterThanOrEqual(0);
		expect(tabsIndex).toBeLessThan(editorBorderIndex);
		expect(rendered).toContain("Steered task-a.");
		expect(rendered).toContain("Enter submit");
		expect(rendered).not.toContain("Ctrl+S");
	});
});
