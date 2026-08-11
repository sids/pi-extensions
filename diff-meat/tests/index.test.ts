import { describe, expect, test } from "vitest";
import { createDiffMeatExtension } from "../index";
import { loadDiffMeatConfig } from "../config";
import type { PreparedDiff, ReadingDiff } from "../types";

type ReviewResult = { approved: boolean; feedback?: string; exit?: boolean };
type Handler = (args: string, ctx: any) => void | Promise<void>;

const prepared: PreparedDiff = {
	rawPatch: "diff --git a/a b/a\n@@ -1 +1 @@\n-old\n+new\n",
	gitRef: "Uncommitted changes",
	diffType: "uncommitted",
	repoRoot: "/repo",
};
const reading: ReadingDiff = {
	rawPatch: prepared.rawPatch,
	summary: "Changes behavior.",
	keptSections: 1,
	totalSections: 2,
	usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 },
	fromCache: false,
};

function createHarness(options: {
	isGitRepository?: boolean;
	reading?: ReadingDiff | Promise<ReadingDiff>;
	result?: ReviewResult | Promise<ReviewResult>;
	error?: Error;
	isIdle?: boolean;
} = {}) {
	const commands = new Map<string, Handler>();
	const notifications: Array<{ message: string; level?: string }> = [];
	const statuses: Array<string | undefined> = [];
	const openCalls: Array<{ cwd: string; prepared: PreparedDiff; reading: ReadingDiff }> = [];
	const abridgeContexts: string[] = [];
	const sentMessages: Array<{ message: any; options?: unknown }> = [];
	const extension = createDiffMeatExtension({
		isGitRepository: async () => options.isGitRepository ?? true,
		resolveDiffTargetFromArgs: async () => ({ type: "uncommitted" }),
		preparePlannotatorContext: async (ctx) => ctx,
		loadConfig: () => loadDiffMeatConfig({ DIFF_MEAT_CACHE: "0" }),
		prepareDiff: async () => {
			if (options.error) throw options.error;
			return prepared;
		},
		buildDiffContext: async () => "User:\nPlease change the call.\n\nAssistant:\nDone.",
		abridgeDiff: async (_pi, _ctx, _patch, abridgeOptions) => {
			abridgeContexts.push(abridgeOptions?.taskContext ?? "");
			abridgeOptions?.onProgress?.({
				message: "Abridging chunk 1/1",
				usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 },
			});
			return options.reading ?? reading;
		},
		openReadingDiffReview: async (_ctx, cwd, preparedDiff, readingDiff) => {
			openCalls.push({ cwd, prepared: preparedDiff, reading: readingDiff });
			return options.result ?? { approved: false, feedback: "Keep another hunk." };
		},
	});
	const pi = {
		registerCommand(name: string, command: { handler: Handler }) {
			commands.set(name, command.handler);
		},
		registerMessageRenderer() {},
		sendMessage(message: any, sendOptions?: unknown) {
			sentMessages.push({ message, options: sendOptions });
		},
	} as any;
	const ctx = {
		hasUI: true,
		mode: "rpc",
		cwd: "/repo",
		isIdle: () => options.isIdle ?? true,
		ui: {
			notify: (message: string, level?: string) => notifications.push({ message, level }),
			setStatus: (_key: string, value: string | undefined) => statuses.push(value),
			theme: {
				fg: (_color: string, text: string) => text,
				underline: (text: string) => text,
			},
		},
	} as any;
	extension(pi);

	const start = async (args = "") => {
		const handler = commands.get("diff-meat");
		if (!handler) throw new Error("Missing /diff-meat handler");
		await handler(args, ctx);
	};

	return {
		start,
		async run(args = "") {
			await start(args);
			await new Promise<void>((resolve) => setImmediate(resolve));
		},
		notifications,
		statuses,
		openCalls,
		abridgeContexts,
		sentMessages,
	};
}

describe("diff-meat extension", () => {
	test("abridges, opens Plannotator, and sends requested changes", async () => {
		const harness = createHarness();
		await harness.run("uncommitted");

		expect(harness.openCalls).toEqual([{ cwd: "/repo", prepared, reading }]);
		expect(harness.abridgeContexts).toEqual(["User:\nPlease change the call.\n\nAssistant:\nDone."]);
		expect(harness.statuses.at(-1)).toBeUndefined();
		expect(harness.notifications).toContainEqual({
			message: "Reading diff keeps 1/2 sections (50%) · 100 input / 20 output tokens.",
			level: "info",
		});
		expect(harness.sentMessages).toEqual([{
			message: expect.objectContaining({ content: "Keep another hunk." }),
			options: { deliverAs: "steer", triggerTurn: true },
		}]);
	});

	test("keeps diff abridgement blocking", async () => {
		let resolveReading!: (result: ReadingDiff) => void;
		const pendingReading = new Promise<ReadingDiff>((resolve) => {
			resolveReading = resolve;
		});
		const harness = createHarness({ reading: pendingReading });
		let completed = false;

		const run = harness.start("uncommitted").then(() => {
			completed = true;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(completed).toBe(false);
		expect(harness.openCalls).toEqual([]);

		resolveReading(reading);
		await run;
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(completed).toBe(true);
		expect(harness.openCalls).toEqual([{ cwd: "/repo", prepared, reading }]);
	});

	test("returns control to pi while the browser review remains open", async () => {
		let resolveReview!: (result: ReviewResult) => void;
		const result = new Promise<ReviewResult>((resolve) => {
			resolveReview = resolve;
		});
		const harness = createHarness({ result, isIdle: false });

		await harness.run("uncommitted");

		expect(harness.openCalls).toEqual([{ cwd: "/repo", prepared, reading }]);
		expect(harness.sentMessages).toEqual([]);

		resolveReview({ approved: false, feedback: "Keep this reading focused." });
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(harness.sentMessages).toEqual([{
			message: expect.objectContaining({ content: "Keep this reading focused." }),
			options: { deliverAs: "steer", triggerTurn: true },
		}]);
	});

	test("does not open a browser when no sections remain", async () => {
		const harness = createHarness({
			reading: { ...reading, rawPatch: "", keptSections: 0, summary: "Only generated files changed." },
		});
		await harness.run();

		expect(harness.openCalls).toEqual([]);
		expect(harness.notifications).toContainEqual({ message: "Only generated files changed.", level: "info" });
	});

	test("fails outside git repositories", async () => {
		const harness = createHarness({ isGitRepository: false });
		await harness.run();
		expect(harness.notifications).toContainEqual({
			message: "This command only works inside a git repository.",
			level: "error",
		});
	});

	test("reports preparation failures", async () => {
		const harness = createHarness({ error: new Error("No changes found") });
		await harness.run();
		expect(harness.notifications).toContainEqual({ message: "No changes found", level: "error" });
	});
});
