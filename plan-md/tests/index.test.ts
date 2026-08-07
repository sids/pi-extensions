import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import planMdExtension from "../index";

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		rmSync(tempDirs.pop()!, { recursive: true, force: true });
	}
});

type Handler = (event: any, ctx: any) => any;

function createHarness(
	entries: any[],
	options: {
		cwd?: string;
		hasUI?: boolean;
		mode?: string;
		reviewPlanInBrowser?: (...args: any[]) => Promise<{ approved: boolean; feedback?: string }>;
	} = {},
) {
	const handlers = new Map<string, Handler[]>();
	const appendedEntries: Array<{ customType: string; data: any }> = [];
	const sentMessages: any[] = [];
	const sentUserMessages: Array<{ message: string; options?: unknown }> = [];
	const editorValues: string[] = [];
	const scheduledReviews: Array<() => Promise<void>> = [];
	const tools: any[] = [];
	const entryRenderers = new Map<string, any>();
	const messageRenderers = new Map<string, any>();
	let activeTools: string[] = [];

	const pi = {
		on(name: string, handler: Handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		appendEntry(customType: string, data: any) {
			appendedEntries.push({ customType, data });
			entries.push({ type: "custom", customType, data });
		},
		getActiveTools() {
			return activeTools;
		},
		setActiveTools(nextTools: string[]) {
			activeTools = nextTools;
		},
		registerMessageRenderer(customType: string, renderer: any) {
			messageRenderers.set(customType, renderer);
		},
		registerEntryRenderer(customType: string, renderer: any) {
			entryRenderers.set(customType, renderer);
		},
		registerTool(tool: any) {
			tools.push(tool);
		},
		registerCommand() {},
		registerShortcut() {},
		sendMessage(message: any) {
			sentMessages.push(message);
		},
		sendUserMessage(message: string, sendOptions?: unknown) {
			sentUserMessages.push({ message, options: sendOptions });
		},
	} as any;

	planMdExtension(pi, {
		schedulePlanReview: (review) => scheduledReviews.push(review),
		...(options.reviewPlanInBrowser ? { reviewPlanInBrowser: options.reviewPlanInBrowser } : {}),
	});

	const ctx = {
		hasUI: options.hasUI ?? false,
		mode: options.mode,
		cwd: options.cwd ?? "/tmp",
		isIdle: () => true,
		ui: {
			notify() {},
			setWidget() {},
			setEditorText(value: string) {
				editorValues.push(value);
			},
		},
		sessionManager: {
			getEntries: () => entries,
			getLeafId: () => "planning-leaf",
			getSessionFile: () => undefined,
			getSessionDir: () => "/tmp",
			getSessionId: () => "session-1",
		},
	} as any;

	async function emit(name: string, event: any = {}) {
		const list = handlers.get(name) ?? [];
		let result;
		for (const handler of list) {
			result = await handler(event, ctx);
		}
		return result;
	}

	return {
		emit,
		async runScheduledReview() {
			const review = scheduledReviews.shift();
			if (!review) {
				throw new Error("No plan review was scheduled");
			}
			await review();
		},
		appendedEntries,
		entryRenderers,
		messageRenderers,
		sentMessages,
		sentUserMessages,
		editorValues,
		scheduledReviews,
		tools,
		ctx,
	};
}

describe("plan-md prompt injection", () => {
	test("registers plan mode tools with prompt snippets", async () => {
		const harness = createHarness([]);
		const toolByName = new Map(harness.tools.map((tool) => [tool.name, tool]));

		const setPlanTool = toolByName.get("set_plan");
		expect(setPlanTool?.description).toBe(
			"Persist the full latest implementation plan and queue browser review for after the current turn when the request calls for creating or revising one.",
		);
		expect(setPlanTool?.promptSnippet).toBe(
			"Persist a complete implementation plan for browser review after the current turn.",
		);
		expect(setPlanTool?.promptGuidelines).toEqual([
			"Use set_plan only when the current request calls for creating or revising a concrete implementation plan. After calling it, finish the response and wait for browser review; if review requests changes, revise the plan and call set_plan again.",
		]);
		expect(setPlanTool?.constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });
		expect(toolByName.get("request_user_input")?.promptSnippet).toBe(
			"Ask the user one or more short questions and wait for answers.",
		);
		expect(toolByName.get("request_user_input")?.promptGuidelines).toEqual([
			"Use request_user_input in Plan mode when a short answer from the user is required before writing or revising the plan.",
		]);
		expect(toolByName.get("request_user_input")?.constrainedSampling).toBe(false);
		expect(toolByName.get("request_user_input")?.executionMode).toBe("sequential");
	});

	test("set_plan throws when plan mode is inactive", async () => {
		const harness = createHarness([]);
		const setPlanTool = harness.tools.find((tool) => tool.name === "set_plan");
		if (!setPlanTool) {
			throw new Error("set_plan tool was not registered");
		}

		let error: unknown;
		try {
			await setPlanTool.execute("call-1", { plan: "Goal\n- Step 1" }, undefined, undefined, {
				cwd: "/tmp",
				hasUI: false,
				sessionManager: {
					getEntries: () => [],
					getSessionFile: () => undefined,
					getSessionDir: () => "/tmp",
					getSessionId: () => "session-1",
				},
			});
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("plan mode is active");
	});

	test("set_plan opens browser review after the turn settles and preserves approval notes", async () => {
		const tempDir = mkdtempSync(path.join(os.tmpdir(), "plan-md-review-"));
		tempDirs.push(tempDir);
		const planFilePath = path.join(tempDir, "session.plan.md");
		const reviewCalls: Array<{ plan: string; signal?: AbortSignal }> = [];
		const entries = [{
			type: "custom",
			customType: "plan-md:state",
			data: { version: 1, active: true, planFilePath },
		}];
		const harness = createHarness(entries, {
			cwd: tempDir,
			hasUI: true,
			reviewPlanInBrowser: async (_ctx, plan, signal) => {
				reviewCalls.push({ plan, signal });
				return { approved: true, feedback: "Keep compatibility." };
			},
		});
		await harness.emit("session_start");
		const setPlanTool = harness.tools.find((tool) => tool.name === "set_plan");
		const signal = new AbortController().signal;

		const result = await setPlanTool.execute(
			"call-1",
			{ plan: "# Goal\n\n- Step 1" },
			signal,
			undefined,
			harness.ctx,
		);

		expect(readFileSync(planFilePath, "utf8")).toBe("# Goal\n\n- Step 1\n");
		expect(result.content[0]?.text).toContain("browser review will open after the turn ends");
		expect(result.details).toEqual({ plan: "# Goal\n\n- Step 1" });
		expect(result.terminate).toBeUndefined();
		expect(reviewCalls).toEqual([]);
		expect(harness.scheduledReviews).toHaveLength(0);

		await harness.emit("agent_settled");

		expect(reviewCalls).toEqual([]);
		expect(harness.scheduledReviews).toHaveLength(1);
		await harness.runScheduledReview();

		expect(reviewCalls).toEqual([{ plan: "# Goal\n\n- Step 1", signal: undefined }]);
		expect(harness.appendedEntries.at(-1)?.data).toMatchObject({
			active: false,
			lastPlanLeafId: "planning-leaf",
		});
		expect(harness.editorValues).toEqual([
			`Plan file: ${planFilePath}\nImplement the approved plan in this file. Keep changes focused, update tests, and summarize what was implemented.\n\nApproval notes:\nKeep compatibility.`,
		]);
		expect(harness.sentMessages.at(-1)).toMatchObject({
			customType: "plan-md:exit",
			content: "Plan mode ended.",
		});
	});

	test("browser review sends requested changes after the completed turn", async () => {
		const tempDir = mkdtempSync(path.join(os.tmpdir(), "plan-md-review-"));
		tempDirs.push(tempDir);
		const planFilePath = path.join(tempDir, "session.plan.md");
		const entries = [{
			type: "custom",
			customType: "plan-md:state",
			data: { version: 1, active: true, planFilePath, approvalFeedback: "Old notes" },
		}];
		const harness = createHarness(entries, {
			cwd: tempDir,
			hasUI: true,
			reviewPlanInBrowser: async () => ({ approved: false, feedback: "Add rollback steps." }),
		});
		await harness.emit("session_start");
		const setPlanTool = harness.tools.find((tool) => tool.name === "set_plan");

		const result = await setPlanTool.execute(
			"call-1",
			{ plan: "# Goal\n\n- Step 1" },
			undefined,
			undefined,
			harness.ctx,
		);

		expect(result.content[0]?.text).toContain("browser review will open after the turn ends");
		expect(result.details).toEqual({ plan: "# Goal\n\n- Step 1" });
		expect(harness.sentUserMessages).toEqual([]);

		await harness.emit("agent_settled");
		await harness.runScheduledReview();

		expect(harness.sentUserMessages).toEqual([
			{ message: "Add rollback steps.", options: undefined },
		]);
		expect(harness.appendedEntries).toContainEqual({
			customType: "plan-md:review-feedback",
			data: {
				planFilePath,
				feedback: "Add rollback steps.",
			},
		});
		const feedbackRenderer = harness.entryRenderers.get("plan-md:review-feedback");
		const renderedFeedback = feedbackRenderer(
			{ data: { planFilePath, feedback: "Add rollback steps." } },
			{},
			{
				bg: (_name: string, text: string) => text,
				fg: (_name: string, text: string) => text,
				bold: (text: string) => text,
			},
		).render(80).join("\n");
		expect(renderedFeedback).toContain("Plan review requested changes");
		expect(renderedFeedback).toContain("Add rollback steps.");
		expect(
			harness.appendedEntries
				.filter((entry) => entry.customType === "plan-md:state")
				.at(-1)?.data.approvalFeedback,
		).toBeUndefined();
	});

	test("set_plan skips browser review in RPC mode", async () => {
		const tempDir = mkdtempSync(path.join(os.tmpdir(), "plan-md-review-"));
		tempDirs.push(tempDir);
		const planFilePath = path.join(tempDir, "session.plan.md");
		let reviewCalled = false;
		const entries = [{
			type: "custom",
			customType: "plan-md:state",
			data: { version: 1, active: true, planFilePath },
		}];
		const harness = createHarness(entries, {
			cwd: tempDir,
			hasUI: true,
			mode: "rpc",
			reviewPlanInBrowser: async () => {
				reviewCalled = true;
				return { approved: true };
			},
		});
		await harness.emit("session_start");
		const setPlanTool = harness.tools.find((tool) => tool.name === "set_plan");

		const result = await setPlanTool.execute(
			"call-1",
			{ plan: "# Goal\n\n- Step 1" },
			undefined,
			undefined,
			harness.ctx,
		);

		expect(reviewCalled).toBe(false);
		expect(result.content[0]?.text).toContain("only available in TUI mode");
		expect(result.details).toEqual({ plan: "# Goal\n\n- Step 1" });
		expect(harness.editorValues).toEqual([]);
	});

	test("posts the prompt only once until the session is compacted", async () => {
		const entries = [
			{
				type: "custom",
				customType: "plan-md:state",
				data: {
					version: 1,
					active: true,
					planFilePath: "/tmp/session-1.plan.md",
					promptPending: true,
				},
			},
		];
		const harness = createHarness(entries);

		await harness.emit("session_start");

		const firstResult = await harness.emit("before_agent_start", { prompt: "first" });
		expect(firstResult).toMatchObject({
			message: {
				customType: "plan-md:context",
				display: false,
			},
		});
		expect(typeof firstResult.message.content).toBe("string");
		expect(firstResult.message.content.length).toBeGreaterThan(0);

		const secondResult = await harness.emit("before_agent_start", { prompt: "second" });
		expect(secondResult).toBeUndefined();

		await harness.emit("session_compact");
		expect(harness.sentMessages).toEqual([
			{
				customType: "plan-md:prompt",
				content: "Plan mode instructions",
				display: true,
				details: {
					activationId: undefined,
					instructionsPrompt: expect.any(String),
				},
			},
		]);

		const thirdResult = await harness.emit("before_agent_start", { prompt: "third" });
		expect(thirdResult).toMatchObject({
			message: {
				customType: "plan-md:context",
				display: false,
			},
		});

		expect(
			harness.appendedEntries
				.filter((entry) => entry.customType === "plan-md:state")
				.map((entry) => entry.data.promptPending),
		).toEqual([false, true, false]);
	});

	test("hides stale plan mode prompt messages when inactive or from another activation", async () => {
		const entries = [
			{
				type: "custom",
				customType: "plan-md:state",
				data: {
					version: 1,
					active: true,
					activationId: "plan-current",
					planFilePath: "/tmp/session-1.plan.md",
				},
			},
		];
		const harness = createHarness(entries);
		await harness.emit("session_start");

		const renderer = harness.messageRenderers.get("plan-md:prompt");
		expect(renderer).toBeDefined();

		const theme = {
			bg: (_name: string, text: string) => text,
			fg: (_name: string, text: string) => text,
			bold: (text: string) => text,
		} as any;

		const rendered = renderer(
			{
				content: "Plan mode instructions",
				details: {
					activationId: "plan-current",
					instructionsPrompt: "Plan prompt",
				},
			},
			{ expanded: true, outputPad: 4 },
			theme,
		).render(80).join("\n");
		expect(rendered).toMatch(/^ {4}Plan prompt/);

		expect(
			renderer(
				{
					content: "Plan mode instructions",
					details: {
						activationId: "plan-old",
						instructionsPrompt: "Plan prompt",
					},
				},
				{ expanded: false },
				theme,
			),
		).toBeUndefined();

		entries.push({
			type: "custom",
			customType: "plan-md:state",
			data: {
				version: 1,
				active: false,
				planFilePath: "/tmp/session-1.plan.md",
			},
		});
		await harness.emit("session_tree");

		expect(
			renderer(
				{
					content: "Plan mode instructions",
					details: {
						activationId: "plan-current",
						instructionsPrompt: "Plan prompt",
					},
				},
				{ expanded: false },
				theme,
			),
		).toBeUndefined();
	});
});
