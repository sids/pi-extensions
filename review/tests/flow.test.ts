import { describe, expect, test } from "bun:test";
import { registerReviewCommand } from "../flow";

function createRegisteredReviewHandler(options: {
	stateManager: {
		getState: () => any;
		setState: (ctx: any, nextState: any) => void;
		startReviewMode: (ctx: any, opts: any) => void;
	};
	flow?: Record<string, unknown>;
	onReviewEnded?: (summary: any) => void;
	pi?: Record<string, unknown>;
}) {
	let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
	const commandNames: string[] = [];
	const sentUserMessages: string[] = [];
	const sentMessages: any[] = [];

	const pi = {
		registerCommand: (name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) => {
			commandNames.push(name);
			handler = command.handler;
		},
		sendUserMessage: (message: string) => sentUserMessages.push(message),
		sendMessage: (message: any) => sentMessages.push(message),
		getThinkingLevel: () => "off",
		setThinkingLevel: () => {},
		setModel: async () => true,
		...(options.pi ?? {}),
	} as any;

	registerReviewCommand(pi, {
		stateManager: options.stateManager,
		flow: options.flow as any,
		onReviewEnded: options.onReviewEnded,
	});

	if (!handler) {
		throw new Error("Failed to register /review handler");
	}

	return { handler, commandNames, sentUserMessages, sentMessages, pi };
}

describe("registerReviewCommand", () => {
	test("registers only /review command", () => {
		const { commandNames } = createRegisteredReviewHandler({
			stateManager: {
				getState: () => ({ version: 1, active: false }),
				setState: () => {},
				startReviewMode: () => {},
			},
		});

		expect(commandNames).toEqual(["review"]);
	});
});

describe("/review inactive", () => {
	test("asks start location first, then starts review and prefills editor", async () => {
		const startCalls: any[] = [];
		const notifications: Array<{ message: string; level: string }> = [];
		const editorPrefills: string[] = [];
		const callOrder: string[] = [];
		const { handler, sentMessages, sentUserMessages } = createRegisteredReviewHandler({
			stateManager: {
				getState: () => ({ version: 1, active: false }),
				setState: () => {},
				startReviewMode: (_ctx, options) => startCalls.push(options),
			},
			flow: {
				isGitRepository: async () => true,
				resolveTarget: async () => {
					callOrder.push("resolve-target");
					return { type: "uncommitted" };
				},
				buildInstructionsPrompt: async () => "review instructions",
				buildEditorPrompt: async () => "review target prompt",
				describeTarget: () => "current changes",
			},
			pi: {
				getThinkingLevel: () => "high",
			},
		});

		await handler("", {
			hasUI: true,
			cwd: "/tmp/project",
			model: { provider: "anthropic", id: "claude-sonnet" },
			waitForIdle: async () => {},
			sessionManager: {
				getLeafId: () => "leaf-2",
				getEntries: () => [
					{ id: "user-1", type: "message", message: { role: "user" } },
					{ id: "leaf-2", type: "message", message: { role: "assistant" } },
				],
			},
			ui: {
				select: async () => {
					callOrder.push("select-start-location");
					return "Current branch";
				},
				notify: (message: string, level: string) => notifications.push({ message, level }),
				setEditorText: (text: string) => editorPrefills.push(text),
			},
		});

		expect(callOrder).toEqual(["select-start-location", "resolve-target"]);
		expect(startCalls).toEqual([
			{
				originLeafId: "leaf-2",
				runId: expect.any(String),
				targetHint: "current changes",
				reviewInstructionsPrompt: "review instructions",
				originModelProvider: "anthropic",
				originModelId: "claude-sonnet",
				originThinkingLevel: "high",
			},
		]);
		expect(editorPrefills).toEqual(["review target prompt"]);
		expect(sentUserMessages).toEqual([]);
		expect(sentMessages).toEqual([
			{
				customType: "review-mode:prompt",
				content: "Review instructions",
				display: true,
				details: {
					targetHint: "current changes",
					instructionsPrompt: "review instructions",
				},
			},
		]);
		expect(notifications).toContainEqual({
			message: "Review mode ready: current changes. Edit and send when ready.",
			level: "info",
		});
	});

	test("does not resolve target when start-location prompt is cancelled", async () => {
		const resolveCalls: string[] = [];
		const notifications: Array<{ message: string; level: string }> = [];
		const { handler } = createRegisteredReviewHandler({
			stateManager: {
				getState: () => ({ version: 1, active: false }),
				setState: () => {},
				startReviewMode: () => {},
			},
			flow: {
				isGitRepository: async () => true,
				resolveTarget: async () => {
					resolveCalls.push("resolve");
					return { type: "uncommitted" };
				},
			},
		});

		await handler("", {
			hasUI: true,
			cwd: "/tmp/project",
			waitForIdle: async () => {},
			sessionManager: {
				getLeafId: () => "leaf-2",
				getEntries: () => [
					{ id: "user-1", type: "message", message: { role: "user" } },
					{ id: "leaf-2", type: "message", message: { role: "assistant" } },
				],
			},
			ui: {
				select: async () => undefined,
				notify: (message: string, level: string) => notifications.push({ message, level }),
			},
		});

		expect(resolveCalls).toEqual([]);
		expect(notifications).toContainEqual({ message: "Review cancelled.", level: "info" });
	});

	test("skips start-location prompt when there is no prior history", async () => {
		const startCalls: any[] = [];
		const resolveCalls: string[] = [];
		const selectCalls: Array<{ prompt: string; choices: string[] }> = [];
		const { handler } = createRegisteredReviewHandler({
			stateManager: {
				getState: () => ({ version: 1, active: false }),
				setState: () => {},
				startReviewMode: (_ctx, options) => startCalls.push(options),
			},
			flow: {
				isGitRepository: async () => true,
				resolveTarget: async () => {
					resolveCalls.push("resolve");
					return { type: "uncommitted" };
				},
				buildInstructionsPrompt: async () => "review instructions",
				buildEditorPrompt: async () => "review target prompt",
				describeTarget: () => "current changes",
			},
		});

		await handler("", {
			hasUI: true,
			cwd: "/tmp/project",
			waitForIdle: async () => {},
			sessionManager: {
				getLeafId: () => "leaf-1",
				getEntries: () => [{ id: "leaf-1", type: "message", message: { role: "user" } }],
			},
			ui: {
				select: async (prompt: string, choices: string[]) => {
					selectCalls.push({ prompt, choices });
					return "Empty branch";
				},
				notify: () => {},
				setEditorText: () => {},
			},
		});

		expect(selectCalls).toEqual([]);
		expect(resolveCalls).toEqual(["resolve"]);
		expect(startCalls).toHaveLength(1);
		expect(startCalls[0].originLeafId).toBe("leaf-1");
	});

	test("does not checkout PR when empty-branch navigation is cancelled", async () => {
		const startCalls: any[] = [];
		const checkoutCalls: any[] = [];
		const notifications: Array<{ message: string; level: string }> = [];
		const { handler, sentUserMessages } = createRegisteredReviewHandler({
			stateManager: {
				getState: () => ({ version: 1, active: false }),
				setState: () => {},
				startReviewMode: (_ctx, options) => startCalls.push(options),
			},
			flow: {
				isGitRepository: async () => true,
				resolveTarget: async () => ({
					type: "pullRequest",
					prNumber: 42,
					baseBranch: "main",
					title: "Fix issue",
				}),
				checkoutTarget: async (_pi: any, _ctx: any, target: any) => {
					checkoutCalls.push(target);
					return true;
				},
				buildInstructionsPrompt: async () => "instructions",
				buildEditorPrompt: async () => "editor prompt",
				describeTarget: () => "PR #42",
			},
		});

		await handler("pr 42", {
			hasUI: true,
			cwd: "/tmp/project",
			waitForIdle: async () => {},
			navigateTree: async () => ({ cancelled: true }),
			sessionManager: {
				getLeafId: () => "leaf-1",
				getEntries: () => [{ id: "user-1", type: "message", message: { role: "user" } }],
			},
			ui: {
				select: async () => "Empty branch",
				notify: (message: string, level: string) => notifications.push({ message, level }),
				setEditorText: () => {},
			},
		});

		expect(checkoutCalls).toEqual([]);
		expect(startCalls).toEqual([]);
		expect(sentUserMessages).toEqual([]);
		expect(notifications).toContainEqual({ message: "Review cancelled.", level: "info" });
	});

	test("retries target selection when checkout fails in selector flow", async () => {
		const startCalls: any[] = [];
		const resolveCalls: string[] = [];
		const checkoutTargets: any[] = [];
		const notifications: Array<{ message: string; level: string }> = [];
		let targetAttempt = 0;

		const { handler } = createRegisteredReviewHandler({
			stateManager: {
				getState: () => ({ version: 1, active: false }),
				setState: () => {},
				startReviewMode: (_ctx, options) => startCalls.push(options),
			},
			flow: {
				isGitRepository: async () => true,
				resolveTarget: async (_pi: any, _ctx: any, args: string) => {
					resolveCalls.push(args);
					targetAttempt += 1;
					if (targetAttempt === 1) {
						return { type: "pullRequest", prNumber: 1, baseBranch: "main", title: "First" };
					}
					return { type: "pullRequest", prNumber: 2, baseBranch: "main", title: "Second" };
				},
				checkoutTarget: async (_pi: any, _ctx: any, target: any) => {
					checkoutTargets.push(target);
					return target.prNumber === 2;
				},
				buildInstructionsPrompt: async () => "instructions",
				buildEditorPrompt: async (_pi: any, _cwd: string, target: any) => `editor ${target.prNumber}`,
				describeTarget: (target: any) => `PR #${target.prNumber}`,
			},
		});

		await handler("", {
			hasUI: true,
			cwd: "/tmp/project",
			waitForIdle: async () => {},
			sessionManager: {
				getLeafId: () => "leaf-2",
				getEntries: () => [
					{ id: "user-1", type: "message", message: { role: "user" } },
					{ id: "leaf-2", type: "message", message: { role: "assistant" } },
				],
			},
			ui: {
				select: async () => "Current branch",
				notify: (message: string, level: string) => notifications.push({ message, level }),
				setEditorText: () => {},
			},
		});

		expect(resolveCalls).toEqual(["", ""]);
		expect(checkoutTargets.map((target) => target.prNumber)).toEqual([1, 2]);
		expect(notifications).toContainEqual({ message: "Please select a different review target.", level: "info" });
		expect(startCalls.at(-1)?.targetHint).toBe("PR #2");
	});

	test("returns to origin branch when checkout fails after moving to empty branch", async () => {
		const startCalls: any[] = [];
		const checkoutCalls: any[] = [];
		const navigateCalls: Array<{ entryId: string; options: any }> = [];
		const notifications: Array<{ message: string; level: string }> = [];
		const { handler, sentUserMessages } = createRegisteredReviewHandler({
			stateManager: {
				getState: () => ({ version: 1, active: false }),
				setState: () => {},
				startReviewMode: (_ctx, options) => startCalls.push(options),
			},
			flow: {
				isGitRepository: async () => true,
				resolveTarget: async () => ({
					type: "pullRequest",
					prNumber: 42,
					baseBranch: "main",
					title: "Fix issue",
				}),
				checkoutTarget: async (_pi: any, _ctx: any, target: any) => {
					checkoutCalls.push(target);
					return false;
				},
				buildInstructionsPrompt: async () => "instructions",
				buildEditorPrompt: async () => "editor prompt",
				describeTarget: () => "PR #42",
			},
		});

		await handler("pr 42", {
			hasUI: true,
			cwd: "/tmp/project",
			waitForIdle: async () => {},
			navigateTree: async (entryId: string, options: any) => {
				navigateCalls.push({ entryId, options });
				return { cancelled: false };
			},
			sessionManager: {
				getLeafId: () => "origin-leaf",
				getEntries: () => [
					{ id: "user-1", type: "message", message: { role: "user" } },
					{ id: "origin-leaf", type: "message", message: { role: "assistant" } },
				],
			},
			ui: {
				select: async () => "Empty branch",
				notify: (message: string, level: string) => notifications.push({ message, level }),
				setEditorText: () => {},
			},
		});

		expect(checkoutCalls).toEqual([
			{
				type: "pullRequest",
				prNumber: 42,
				baseBranch: "main",
				title: "Fix issue",
			},
		]);
		expect(navigateCalls).toEqual([
			{
				entryId: "user-1",
				options: { summarize: false, label: "review-mode" },
			},
			{
				entryId: "origin-leaf",
				options: { summarize: false, label: "review-mode" },
			},
		]);
		expect(startCalls).toEqual([]);
		expect(sentUserMessages).toEqual([]);
		expect(notifications.some((event) => event.message === "Review cancelled.")).toBe(false);
	});

	test("direct-arg target resolution failure restores origin without cancel message", async () => {
		const startCalls: any[] = [];
		const navigateCalls: Array<{ entryId: string; options: any }> = [];
		const notifications: Array<{ message: string; level: string }> = [];
		const { handler } = createRegisteredReviewHandler({
			stateManager: {
				getState: () => ({ version: 1, active: false }),
				setState: () => {},
				startReviewMode: (_ctx, options) => startCalls.push(options),
			},
			flow: {
				isGitRepository: async () => true,
				resolveTarget: async () => {
					notifications.push({ message: "PR not found", level: "error" });
					return null;
				},
			},
		});

		await handler("pr 999", {
			hasUI: true,
			cwd: "/tmp/project",
			waitForIdle: async () => {},
			navigateTree: async (entryId: string, options: any) => {
				navigateCalls.push({ entryId, options });
				return { cancelled: false };
			},
			sessionManager: {
				getLeafId: () => "origin-leaf",
				getEntries: () => [
					{ id: "user-1", type: "message", message: { role: "user" } },
					{ id: "origin-leaf", type: "message", message: { role: "assistant" } },
				],
			},
			ui: {
				select: async () => "Empty branch",
				notify: (message: string, level: string) => notifications.push({ message, level }),
				setEditorText: () => {},
			},
		});

		expect(navigateCalls).toEqual([
			{
				entryId: "user-1",
				options: { summarize: false, label: "review-mode" },
			},
			{
				entryId: "origin-leaf",
				options: { summarize: false, label: "review-mode" },
			},
		]);
		expect(startCalls).toEqual([]);
		expect(notifications).toContainEqual({ message: "PR not found", level: "error" });
		expect(notifications.some((event) => event.message === "Review cancelled.")).toBe(false);
	});
});

describe("/review active", () => {
	test("ends review mode and summarizes only kept comments", async () => {
		let state = {
			version: 1,
			active: true,
			runId: "run-1",
			originLeafId: "origin-leaf",
			targetHint: "changes against 'main'",
		};
		const setStateCalls: any[] = [];
		const navigateCalls: any[] = [];
		const notifications: Array<{ message: string; level: string }> = [];
		const editorPrefills: string[] = [];

		const { handler, sentMessages } = createRegisteredReviewHandler({
			stateManager: {
				getState: () => state,
				setState: (_ctx, next) => {
					setStateCalls.push(next);
					state = next;
				},
				startReviewMode: () => {},
			},
			flow: {
				getCommentsForRun: () => [
					{
						version: 1,
						id: "c1",
						runId: "run-1",
						priority: "P1",
						comment: "kept finding",
						references: [],
						createdAt: 1,
					},
					{
						version: 1,
						id: "c2",
						runId: "run-1",
						priority: "P2",
						comment: "discarded finding",
						references: [],
						createdAt: 2,
					},
				],
				runTriage: async () => ({
					comments: [
						{
							id: "c1",
							keep: true,
							priority: "P1",
							comment: "kept finding",
							references: [],
							note: "focus on the migration path",
							originalPriority: "P1",
						},
						{
							id: "c2",
							keep: false,
							priority: "P2",
							comment: "discarded finding",
							references: [],
							originalPriority: "P2",
						},
					],
					keptCount: 1,
					discardedCount: 1,
				}),
			},
		});

		await handler("", {
			hasUI: true,
			cwd: "/tmp/project",
			waitForIdle: async () => {},
			navigateTree: async (entryId: string, options: any) => {
				navigateCalls.push({ entryId, options });
				return { cancelled: false };
			},
			sessionManager: {
				getLeafId: () => "review-leaf",
				getEntries: () => [{ id: "origin-leaf" }],
			},
			ui: {
				notify: (message: string, level: string) => notifications.push({ message, level }),
				setEditorText: (text: string) => editorPrefills.push(text),
			},
		});

		expect(navigateCalls).toEqual([
			{
				entryId: "origin-leaf",
				options: { summarize: false, label: "review-mode" },
			},
		]);
		expect(setStateCalls.at(-1)).toEqual({
			version: 1,
			active: false,
			lastReviewLeafId: "review-leaf",
		});
		expect(sentMessages).toHaveLength(1);
		expect(sentMessages[0].content).toContain("Code Review Summary");
		expect(sentMessages[0].content).toContain("Comments:");
		expect(sentMessages[0].content).toContain("kept finding");
		expect(sentMessages[0].content).toContain("User Note: focus on the migration path");
		expect(sentMessages[0].content).not.toContain("discarded finding");
		expect(sentMessages[0].content).not.toContain("Review mode ended.");
		expect(sentMessages[0].content).not.toContain("Kept:");
		expect(editorPrefills).toEqual([
			"Address the review comment\n\nPay attention to the user notes in response to the review comments",
		]);
		expect(notifications.length).toBe(0);
	});

	test("does not post a summary when all triaged comments are discarded", async () => {
		let state = {
			version: 1,
			active: true,
			runId: "run-1",
		};
		const setStateCalls: any[] = [];
		const notifications: Array<{ message: string; level: string }> = [];
		const editorPrefills: string[] = [];

		const { handler, sentMessages } = createRegisteredReviewHandler({
			stateManager: {
				getState: () => state,
				setState: (_ctx, next) => {
					setStateCalls.push(next);
					state = next;
				},
				startReviewMode: () => {},
			},
			flow: {
				getCommentsForRun: () => [
					{
						version: 1,
						id: "c1",
						runId: "run-1",
						priority: "P1",
						comment: "discarded finding",
						references: [],
						createdAt: 1,
					},
				],
				runTriage: async () => ({
					comments: [
						{
							id: "c1",
							keep: false,
							priority: "P1",
							comment: "discarded finding",
							references: [],
							originalPriority: "P1",
						},
					],
					keptCount: 0,
					discardedCount: 1,
				}),
			},
		});

		await handler("", {
			hasUI: true,
			cwd: "/tmp/project",
			waitForIdle: async () => {},
			sessionManager: {
				getLeafId: () => "review-leaf",
				getEntries: () => [],
			},
			ui: {
				notify: (message: string, level: string) => notifications.push({ message, level }),
				setEditorText: (text: string) => editorPrefills.push(text),
			},
		});

		expect(setStateCalls.at(-1)).toEqual({
			version: 1,
			active: false,
			lastReviewLeafId: "review-leaf",
		});
		expect(sentMessages).toEqual([]);
		expect(editorPrefills).toEqual([]);
		expect(notifications).toEqual([
			{
				message: "Review mode ended. No review comments were collected.",
				level: "info",
			},
		]);
	});

	test("restores model and thinking after review mode ends", async () => {
		let state = {
			version: 1,
			active: true,
			runId: "run-1",
			originModelProvider: "anthropic",
			originModelId: "claude-sonnet",
			originThinkingLevel: "high",
		};
		let thinkingLevel = "low";
		const restoredModel = { provider: "anthropic", id: "claude-sonnet" };
		const setModelCalls: any[] = [];
		const setThinkingCalls: string[] = [];
		const notifications: Array<{ message: string; level: string }> = [];
		const editorPrefills: string[] = [];

		const { handler, sentMessages } = createRegisteredReviewHandler({
			stateManager: {
				getState: () => state,
				setState: (_ctx, next) => {
					state = next;
				},
				startReviewMode: () => {},
			},
			flow: {
				getCommentsForRun: () => [],
				runTriage: async () => ({ comments: [], keptCount: 0, discardedCount: 0 }),
			},
			pi: {
				getThinkingLevel: () => thinkingLevel,
				setThinkingLevel: (level: string) => {
					setThinkingCalls.push(level);
					thinkingLevel = level;
				},
				setModel: async (model: any) => {
					setModelCalls.push(model);
					return true;
				},
			},
		});

		await handler("", {
			hasUI: true,
			cwd: "/tmp/project",
			model: { provider: "openai", id: "gpt-5" },
			modelRegistry: {
				find: () => restoredModel,
			},
			waitForIdle: async () => {},
			sessionManager: {
				getLeafId: () => "review-leaf",
				getEntries: () => [],
			},
			ui: {
				notify: (message: string, level: string) => notifications.push({ message, level }),
				setEditorText: (text: string) => editorPrefills.push(text),
			},
		});

		expect(setModelCalls).toEqual([restoredModel]);
		expect(setThinkingCalls).toEqual(["high"]);
		expect(sentMessages).toEqual([]);
		expect(editorPrefills).toEqual([]);
		expect(notifications).toContainEqual({
			message: "Review mode ended. Restored model anthropic/claude-sonnet and thinking high.",
			level: "info",
		});
		expect(notifications).toContainEqual({
			message: "Review mode ended. No review comments were collected.",
			level: "info",
		});
	});
});
