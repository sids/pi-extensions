import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import {
	createAnnotateExtension,
	resolveAnnotationRequest,
	type AnnotationDecision,
} from "../index";

const tempDirs: string[] = [];

afterEach(async () => {
	while (tempDirs.length > 0) {
		await rm(tempDirs.pop()!, { recursive: true, force: true });
	}
});

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
type SessionStartHandler = (event: { reason: string }, ctx: ExtensionCommandContext) => Promise<void> | void;
type ShutdownHandler = (event: { reason: string }, ctx: ExtensionCommandContext) => Promise<void> | void;
type SentMessageCall = {
	message: {
		customType: string;
		content: string;
		display: boolean;
	};
	options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" };
};

function assistantEntry(text: string) {
	return {
		id: `assistant-${text}`,
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
		},
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

async function settleBackgroundWork(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function createHarness(options: {
	entries?: unknown[];
	mode?: string;
	isIdle?: boolean;
	startError?: Error;
} = {}) {
	let handler: CommandHandler | undefined;
	let sessionStartHandler: SessionStartHandler | undefined;
	let shutdownHandler: ShutdownHandler | undefined;
	let sessionId = "session-1";
	const decision = deferred<AnnotationDecision>();
	const openedRequests: Array<{ kind: string; message?: string; filePath?: string; folderPath?: string }> = [];
	const notifications: Array<{ message: string; level?: string }> = [];
	const sentMessages: SentMessageCall[] = [];
	let waitForIdleCalls = 0;
	let stopCalls = 0;
	const entries = options.entries ?? [assistantEntry("The latest response.")];
	let leafId = (entries.at(-1) as { id?: string } | undefined)?.id ?? null;
	const loadExtension = (reason: "startup" | "reload" = "startup") => {
		const extension = createAnnotateExtension({
			startAnnotation: async (_ctx, request) => {
				openedRequests.push(request);
				if (options.startError) {
					throw options.startError;
				}
				return {
					url: "http://localhost:19432/annotate/test",
					waitForDecision: () => decision.promise,
					stop() {
						stopCalls += 1;
						decision.reject(new Error("Annotation stopped"));
					},
				};
			},
		});
		const pi = {
			on(name: string, eventHandler: SessionStartHandler | ShutdownHandler) {
				if (name === "session_start") sessionStartHandler = eventHandler as SessionStartHandler;
				if (name === "session_shutdown") shutdownHandler = eventHandler as ShutdownHandler;
			},
			registerCommand(name: string, command: { handler: CommandHandler }) {
				if (name === "annotate") handler = command.handler;
			},
			registerMessageRenderer() {},
			sendMessage(message: SentMessageCall["message"], sendOptions?: SentMessageCall["options"]) {
				sentMessages.push({ message, options: sendOptions });
			},
		};
		extension(pi as unknown as ExtensionAPI);
		void sessionStartHandler?.({ reason }, ctx);
	};
	const ctx = {
		mode: options.mode ?? "tui",
		hasUI: true,
		cwd: "/tmp/project",
		isIdle: () => options.isIdle ?? true,
		waitForIdle: async () => {
			waitForIdleCalls += 1;
		},
		ui: {
			notify: (message: string, level?: "info" | "warning" | "error") => notifications.push({ message, level }),
		},
		sessionManager: {
			getBranch: () => entries,
			getLeafId: () => leafId,
			getSessionId: () => sessionId,
		},
	} as ExtensionCommandContext;

	loadExtension();

	return {
		async run(args = "") {
			if (!handler) {
				throw new Error("Missing /annotate handler");
			}
			await handler(args, ctx);
		},
		resolveDecision(result: AnnotationDecision) {
			decision.resolve(result);
		},
		rejectDecision(error: unknown) {
			decision.reject(error);
		},
		moveBranch() {
			leafId = "sibling-leaf";
		},
		switchSession() {
			sessionId = "session-2";
		},
		async shutdown(reason: "quit" | "reload" | "new" = "quit") {
			if (!shutdownHandler) {
				throw new Error("Missing session_shutdown handler");
			}
			await shutdownHandler({ reason }, ctx);
			await settleBackgroundWork();
		},
		async reload() {
			await this.shutdown("reload");
			loadExtension("reload");
			await settleBackgroundWork();
		},
		openedRequests,
		notifications,
		sentMessages,
		get waitForIdleCalls() {
			return waitForIdleCalls;
		},
		get stopCalls() {
			return stopCalls;
		},
	};
}

describe("annotate extension", () => {
	test("returns control after opening and later sends raw feedback to the agent", async () => {
		const harness = createHarness();
		await harness.run();

		expect(harness.waitForIdleCalls).toBe(1);
		expect(harness.openedRequests).toEqual([{
			kind: "message",
			message: "The latest response.",
			assistantEntryId: "assistant-The latest response.",
		}]);
		expect(harness.sentMessages).toEqual([]);

		const feedback = "# Message Feedback\n\n> Please clarify this.\n> > Preserve my nested quote.";
		harness.resolveDecision({ feedback });
		await settleBackgroundWork();

		expect(harness.sentMessages).toEqual([{
			message: expect.objectContaining({ content: feedback }),
			options: { triggerTurn: true },
		}]);
		expect(harness.notifications).toContainEqual({
			message: "Sent annotation feedback to the agent.",
			level: "info",
		});
	});

	test("queues feedback when the agent is busy", async () => {
		const harness = createHarness({ isIdle: false });
		await harness.run();
		harness.resolveDecision({ feedback: "Please clarify the second paragraph." });
		await settleBackgroundWork();

		expect(harness.sentMessages).toEqual([{
			message: expect.objectContaining({ content: "Please clarify the second paragraph." }),
			options: { deliverAs: "followUp" },
		}]);
	});

	test("does not send anything when the message is approved", async () => {
		const harness = createHarness();
		await harness.run();
		harness.resolveDecision({ approved: true, feedback: "Optional approval note." });
		await settleBackgroundWork();

		expect(harness.sentMessages).toEqual([]);
		expect(harness.notifications).toContainEqual({ message: "Message approved.", level: "info" });
	});

	test("does not send anything when annotation is closed", async () => {
		const harness = createHarness();
		await harness.run();
		harness.resolveDecision({ exit: true, feedback: "" });
		await settleBackgroundWork();

		expect(harness.sentMessages).toEqual([]);
		expect(harness.notifications).toContainEqual({ message: "Annotation closed.", level: "info" });
	});

	test("does not send feedback after the conversation branch moves", async () => {
		const harness = createHarness();
		await harness.run();
		harness.moveBranch();
		harness.resolveDecision({ feedback: "Feedback for the old response." });
		await settleBackgroundWork();

		expect(harness.sentMessages).toEqual([]);
		expect(harness.notifications).toContainEqual({
			message: "Annotation feedback was not sent because the conversation moved.",
			level: "warning",
		});
	});

	test("does not send feedback into a replacement session", async () => {
		const harness = createHarness();
		await harness.run();
		harness.switchSession();
		harness.resolveDecision({ feedback: "Feedback for the old session." });
		await settleBackgroundWork();

		expect(harness.sentMessages).toEqual([]);
		expect(harness.notifications).toContainEqual({
			message: "Annotation feedback was not sent because the conversation moved.",
			level: "warning",
		});
	});

	test("stops the browser session during session shutdown", async () => {
		const harness = createHarness();
		await harness.run();
		await harness.shutdown();

		expect(harness.stopCalls).toBe(1);
		expect(harness.sentMessages).toEqual([]);
		expect(harness.notifications).not.toContainEqual({
			message: "Annotation stopped",
			level: "error",
		});
	});

	test("keeps the browser session and delivers feedback through the reloaded runtime", async () => {
		const harness = createHarness();
		await harness.run();
		await harness.reload();

		expect(harness.stopCalls).toBe(0);
		harness.resolveDecision({ feedback: "Feedback submitted after reload." });
		await settleBackgroundWork();

		expect(harness.sentMessages).toEqual([{
			message: expect.objectContaining({ content: "Feedback submitted after reload." }),
			options: { triggerTurn: true },
		}]);
	});

	test("stops the browser session when starting a new session", async () => {
		const harness = createHarness();
		await harness.run();
		await harness.shutdown("new");

		expect(harness.stopCalls).toBe(1);
		expect(harness.sentMessages).toEqual([]);
	});

	test("reports failures that occur after the browser opens", async () => {
		const harness = createHarness();
		await harness.run();
		harness.rejectDecision(new Error("Browser connection lost"));
		await settleBackgroundWork();

		expect(harness.sentMessages).toEqual([]);
		expect(harness.notifications).toContainEqual({
			message: "Browser connection lost",
			level: "error",
		});
	});

	test("reports a missing assistant message", async () => {
		const harness = createHarness({ entries: [] });
		await harness.run();

		expect(harness.openedRequests).toEqual([]);
		expect(harness.notifications).toContainEqual({
			message: "No assistant message found in this session.",
			level: "error",
		});
	});

	test("skips browser annotation outside TUI mode", async () => {
		const harness = createHarness({ mode: "rpc" });
		await harness.run();

		expect(harness.waitForIdleCalls).toBe(0);
		expect(harness.openedRequests).toEqual([]);
		expect(harness.notifications).toContainEqual({
			message: "Annotation is only available in TUI mode.",
			level: "error",
		});
	});

	test("opens a file and sends feedback with its path", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-annotate-file-"));
		tempDirs.push(dir);
		const filePath = join(dir, "notes.md");
		await writeFile(filePath, "# Notes\n", "utf8");
		const harness = createHarness();

		await harness.run(filePath);
		expect(harness.openedRequests).toEqual([{
			kind: "file",
			filePath,
			markdown: "# Notes\n",
		}]);
		harness.resolveDecision({ feedback: "Clarify this section." });
		await settleBackgroundWork();

		expect(harness.sentMessages[0]?.message.content).toContain(`File: ${filePath}`);
		expect(harness.sentMessages[0]?.message.content).toContain("Clarify this section.");
	});

	test("opens a folder containing annotatable files", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-annotate-folder-"));
		tempDirs.push(dir);
		await mkdir(join(dir, "docs"));
		await writeFile(join(dir, "docs", "notes.md"), "# Notes\n", "utf8");
		const harness = createHarness();

		await harness.run(dir);

		expect(harness.openedRequests).toEqual([{ kind: "folder", folderPath: dir }]);
	});

	test("reports browser startup failures", async () => {
		const harness = createHarness({ startError: new Error("Browser unavailable") });
		await harness.run();

		expect(harness.sentMessages).toEqual([]);
		expect(harness.notifications).toContainEqual({
			message: "Browser unavailable",
			level: "error",
		});
	});
});

describe("annotation URL resolution", () => {
	function createResolutionContext() {
		const notifications: Array<{ message: string; level?: string }> = [];
		return {
			ctx: {
				hasUI: true,
				cwd: "/tmp/project",
				ui: {
					notify: (message: string, level?: string) => notifications.push({ message, level }),
				},
			} as ExtensionCommandContext,
			notifications,
		};
	}

	test("opens a reachable loopback HTML page as a live app", async () => {
		const { ctx, notifications } = createResolutionContext();
		const request = await resolveAnnotationRequest(ctx, "http://localhost:5173/dashboard", {
			probeLiveAppTarget: async () => ({
				liveEligible: true,
				probeError: null,
				probeRedirectedTo: null,
			}),
			isRemoteSession: () => false,
		});

		expect(request).toEqual({
			kind: "url",
			url: "http://localhost:5173/dashboard",
			markdown: "",
			sourceConverted: false,
			live: true,
		});
		expect(notifications).toContainEqual({
			message: "Live app: http://localhost:5173/dashboard",
			level: "info",
		});
	});

	test("uses static conversion when requested", async () => {
		const { ctx } = createResolutionContext();
		const conversions: Array<{ url: string; useJina: boolean }> = [];
		const request = await resolveAnnotationRequest(
			ctx,
			"https://example.com/docs --static --no-jina",
			{
				urlToMarkdown: async (url, options) => {
					conversions.push({ url, useJina: options.useJina });
					return { markdown: "# Documentation", source: "fetch+turndown" };
				},
			},
		);

		expect(conversions).toEqual([{ url: "https://example.com/docs", useJina: false }]);
		expect(request).toEqual({
			kind: "url",
			url: "https://example.com/docs",
			markdown: "# Documentation",
			sourceConverted: true,
			live: false,
		});
	});

	test("reports why forced live mode cannot start", async () => {
		const { ctx } = createResolutionContext();

		await expect(resolveAnnotationRequest(ctx, "http://localhost:5173 --app", {
			probeLiveAppTarget: async () => ({
				liveEligible: false,
				probeError: "connect ECONNREFUSED",
				probeRedirectedTo: null,
			}),
		})).rejects.toThrow(
			"--app: could not reach http://localhost:5173: connect ECONNREFUSED",
		);
	});

	test("refuses live app annotation in remote mode", async () => {
		const { ctx } = createResolutionContext();

		await expect(resolveAnnotationRequest(ctx, "http://localhost:5173", {
			probeLiveAppTarget: async () => ({
				liveEligible: true,
				probeError: null,
				probeRedirectedTo: null,
			}),
			isRemoteSession: () => true,
		})).rejects.toThrow("Live app annotation is unavailable in remote mode");
	});

	test("rejects conflicting live and static flags", async () => {
		const { ctx } = createResolutionContext();

		await expect(resolveAnnotationRequest(
			ctx,
			"http://localhost:5173 --app --static",
		)).rejects.toThrow("--app and --static are mutually exclusive");
	});
});
