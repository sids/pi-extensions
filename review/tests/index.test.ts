import { describe, expect, test } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import reviewExtension from "../index";

initTheme(undefined, false);

type Handler = (event: any, ctx: any) => any;

function createHarness(entries: any[], options?: { tui?: boolean; automaticTriageResult?: unknown }) {
	const handlers = new Map<string, Handler[]>();
	const messageRenderers = new Map<string, any>();
	const commandHandlers = new Map<string, (args: string, ctx: any) => Promise<void>>();
	const shortcutHandlers = new Map<string, (ctx: any) => Promise<void> | void>();
	const editorTexts: string[] = [];
	const sentMessages: any[] = [];
	const sentUserMessages: string[] = [];
	const notifications: Array<{ message: string; level: string }> = [];

	const pi = {
		on(name: string, handler: Handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		appendEntry(customType: string, data: any) {
			entries.push({ type: "custom", customType, data });
		},
		getActiveTools() {
			return [];
		},
		setActiveTools() {},
		registerMessageRenderer(customType: string, renderer: any) {
			messageRenderers.set(customType, renderer);
		},
		registerTool() {},
		registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
			commandHandlers.set(name, command.handler);
		},
		registerShortcut(shortcut: string, options: { handler: (ctx: any) => Promise<void> | void }) {
			shortcutHandlers.set(shortcut, options.handler);
		},
		sendMessage(message: any) {
			sentMessages.push(message);
		},
		sendUserMessage(message: string) {
			sentUserMessages.push(message);
		},
		getThinkingLevel() {
			return "off";
		},
		setThinkingLevel() {},
		setModel: async () => true,
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
	} as any;

	reviewExtension(pi);

	const ctx = {
		mode: options?.tui ? "tui" : "print",
		hasUI: Boolean(options?.tui),
		cwd: "/tmp",
		ui: {
			notify(message: string, level: string) {
				notifications.push({ message, level });
			},
			setWidget() {},
			setEditorText(text: string) {
				editorTexts.push(text);
			},
			custom: async () => options?.automaticTriageResult,
		},
		sessionManager: {
			getEntries: () => entries,
		},
	} as any;

	async function emit(name: string, event: any = {}) {
		const list = handlers.get(name) ?? [];
		for (const handler of list) {
			await handler(event, ctx);
		}
	}

	return {
		emit,
		commandHandlers,
		editorTexts,
		messageRenderers,
		notifications,
		sentMessages,
		sentUserMessages,
		shortcutHandlers,
	};
}

describe("review shortcut", () => {
	test("registers Ctrl+Alt+R", () => {
		const harness = createHarness([]);
		expect(harness.shortcutHandlers.has("ctrl+alt+r")).toBe(true);
	});
});

describe("automatic review exit", () => {
	const activeStateEntry = {
		type: "custom",
		customType: "review-mode:state",
		data: {
			version: 1,
			active: true,
			runId: "review-current",
			targetHint: "current changes",
			reviewInstructionsPrompt: "Review prompt",
		},
	};

	test("preserves restored-session triage until /review provides a command context", async () => {
		const entries: any[] = [activeStateEntry];
		const harness = createHarness(entries, {
			tui: true,
			automaticTriageResult: { comments: [], keptCount: 0, discardedCount: 0 },
		});
		await harness.emit("session_start");
		await harness.emit("agent_settled");
		expect(harness.notifications).toEqual([]);

		await harness.emit("agent_start");
		await harness.emit("agent_settled");
		await new Promise((resolve) => setTimeout(resolve, 5));

		expect(harness.sentUserMessages).toEqual([]);
		expect(harness.editorTexts).toEqual(["/review"]);
		expect(harness.notifications).toContainEqual({
			message: "Review triage is complete. Press Enter to return to the original branch.",
			level: "warning",
		});

		const reviewHandler = harness.commandHandlers.get("review");
		if (!reviewHandler) {
			throw new Error("Review command was not registered");
		}
		await reviewHandler("", {
			mode: "tui",
			hasUI: true,
			cwd: "/tmp",
			waitForIdle: async () => {},
			sessionManager: {
				getLeafId: () => "review-leaf",
				getEntries: () => entries,
			},
			ui: {
				notify: () => {},
				setEditorText: () => {},
				setWidget: () => {},
			},
		});
		const latestState = entries.findLast(
			(entry) => entry.type === "custom" && entry.customType === "review-mode:state",
		)?.data;
		expect(latestState.active).toBe(false);
	});

	test("ends through the captured command context without injecting a slash command", async () => {
		const entries: any[] = [
			{ id: "origin-leaf", type: "message", message: { role: "user" } },
		];
		let currentLeaf = "origin-leaf";
		const navigateCalls: string[] = [];
		const harness = createHarness(entries, {
			tui: true,
			automaticTriageResult: {
				comments: [{
					id: "comment-1",
					keep: true,
					priority: "P1",
					comment: "Fix the race",
					references: [],
					originalPriority: "P1",
				}],
				keptCount: 1,
				discardedCount: 0,
			},
		});
		await harness.emit("session_start");

		const reviewHandler = harness.commandHandlers.get("review");
		if (!reviewHandler) {
			throw new Error("Review command was not registered");
		}
		await reviewHandler("custom review target", {
			mode: "tui",
			hasUI: true,
			cwd: "/tmp",
			waitForIdle: async () => {},
			getSystemPromptOptions: () => ({}),
			navigateTree: async (entryId: string) => {
				navigateCalls.push(entryId);
				currentLeaf = entryId;
				return { cancelled: false };
			},
			sessionManager: {
				getLeafId: () => currentLeaf,
				getEntries: () => entries,
			},
			ui: {
				custom: async () => "edit",
				notify: () => {},
				setEditorText: () => {},
				setWidget: () => {},
			},
		});

		const activeState = entries.findLast(
			(entry) => entry.type === "custom" && entry.customType === "review-mode:state",
		)?.data;
		if (!activeState?.runId) {
			throw new Error("Review mode did not start");
		}
		entries.push({
			type: "custom",
			customType: "review-mode:comment",
			data: {
				version: 1,
				id: "comment-1",
				runId: activeState.runId,
				priority: "P1",
				comment: "Fix the race",
				references: [],
				createdAt: 1,
			},
		});
		currentLeaf = "review-leaf";

		await harness.emit("agent_start");
		await harness.emit("agent_settled");
		await new Promise((resolve) => setTimeout(resolve, 5));

		expect(navigateCalls).toEqual(["origin-leaf"]);
		expect(harness.sentMessages.at(-1)?.content).toContain("Fix the race");
		expect(harness.sentUserMessages).toEqual([
			"Exercise your judgment as to which review comments to accept. Address the comments you accept.",
		]);
	});
});

describe("review change summary renderer", () => {
	test("shows a short preview until expanded", () => {
		const harness = createHarness([]);
		const renderer = harness.messageRenderers.get("review-mode:change-summary");
		expect(renderer).toBeDefined();

		const theme = {
			bg: (_name: string, text: string) => text,
			fg: (_name: string, text: string) => text,
			bold: (text: string) => text,
		} as any;
		const message = {
			content: ["line 1", "line 2", "line 3", "line 4", "line 5"].join("\n"),
		};

		const collapsed = renderer(message, { expanded: false, outputPad: 3 }, theme).render(120).join("\n");
		expect(collapsed).toContain("line 1");
		expect(collapsed).toContain("line 4");
		expect(collapsed).not.toContain("line 5");
		expect(collapsed).toContain("to expand");

		expect(collapsed.split("\n")[0]).toMatch(/^ {3}line 1/);

		const expanded = renderer(message, { expanded: true, outputPad: 3 }, theme).render(120).join("\n");
		expect(expanded).toContain("line 5");
		expect(expanded).not.toContain("to expand");
	});
});

describe("review prompt renderer", () => {
	test("hides stale review prompts when inactive or from another run", async () => {
		const entries = [
			{
				type: "custom",
				customType: "review-mode:state",
				data: {
					version: 1,
					active: true,
					runId: "review-current",
					targetHint: "current changes",
					reviewInstructionsPrompt: "Review prompt",
				},
			},
		];
		const harness = createHarness(entries);
		await harness.emit("session_start");

		const renderer = harness.messageRenderers.get("review-mode:prompt");
		expect(renderer).toBeDefined();

		const theme = {
			bg: (_name: string, text: string) => text,
			fg: (_name: string, text: string) => text,
			bold: (text: string) => text,
		} as any;

		expect(
			renderer(
				{
					content: "Review instructions",
					details: {
						runId: "review-old",
						targetHint: "current changes",
						instructionsPrompt: "Review prompt",
					},
				},
				{ expanded: false },
				theme,
			),
		).toBeUndefined();

		entries.push({
			type: "custom",
			customType: "review-mode:state",
			data: {
				version: 1,
				active: false,
			},
		});
		await harness.emit("session_tree");

		expect(
			renderer(
				{
					content: "Review instructions",
					details: {
						runId: "review-current",
						targetHint: "current changes",
						instructionsPrompt: "Review prompt",
					},
				},
				{ expanded: false },
				theme,
			),
		).toBeUndefined();
	});
});
