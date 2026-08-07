import { describe, expect, test } from "vitest";
import {
	buildCodeReviewOptions,
	createDiffReviewExtension,
} from "../index";
import type { DiffTarget } from "../types";

type Handler = (args: string, ctx: any) => Promise<void>;

function createHarness(options?: {
	isGitRepository?: boolean;
	hasHeadCommit?: boolean;
	target?: DiffTarget | null;
	result?: { approved: boolean; feedback?: string; exit?: boolean };
	openError?: Error;
	isIdle?: boolean;
}) {
	const commands = new Map<string, Handler>();
	const notifications: Array<{ message: string; level?: string }> = [];
	const openCalls: any[] = [];
	const unbornOpenCalls: string[] = [];
	const sentUserMessages: Array<{ message: string; options?: unknown }> = [];

	const getResult = () => {
		if (options?.openError) {
			throw options.openError;
		}
		return options?.result ?? { approved: false, feedback: "Please fix the error handling." };
	};
	const extension = createDiffReviewExtension({
		isGitRepository: async () => options?.isGitRepository ?? true,
		hasHeadCommit: async () => options?.hasHeadCommit ?? true,
		resolveDiffTargetFromArgs: async () => options?.target ?? { type: "uncommitted" },
		openCodeReview: async (_ctx, reviewOptions) => {
			openCalls.push(reviewOptions);
			return getResult();
		},
		openUnbornRepoReview: async (_pi, _ctx, cwd) => {
			unbornOpenCalls.push(cwd);
			return getResult();
		},
	});
	const pi = {
		registerCommand(name: string, command: { handler: Handler }) {
			commands.set(name, command.handler);
		},
		sendUserMessage(message: string, sendOptions?: unknown) {
			sentUserMessages.push({ message, options: sendOptions });
		},
	} as any;
	const ctx = {
		hasUI: true,
		cwd: "/tmp/project",
		isIdle: () => options?.isIdle ?? true,
		ui: {
			notify: (message: string, level?: string) => notifications.push({ message, level }),
		},
	} as any;

	extension(pi);

	return {
		async run(args = "") {
			const handler = commands.get("diff-review");
			if (!handler) {
				throw new Error("Missing /diff-review handler");
			}
			await handler(args, ctx);
		},
		notifications,
		openCalls,
		unbornOpenCalls,
		sentUserMessages,
	};
}

describe("Plannotator target mapping", () => {
	test("maps supported diff-review targets", () => {
		expect(buildCodeReviewOptions("/repo", { type: "uncommitted" })).toEqual({
			cwd: "/repo",
			diffType: "uncommitted",
			vcsType: "git",
		});
		expect(buildCodeReviewOptions("/repo", { type: "baseBranch", branch: "main" })).toEqual({
			cwd: "/repo",
			diffType: "merge-base",
			defaultBranch: "main",
			vcsType: "git",
		});
		expect(buildCodeReviewOptions("/repo", { type: "commit", sha: "abc123" })).toEqual({
			cwd: "/repo",
			diffType: "commit:abc123",
			vcsType: "git",
		});
	});
});

describe("diff-review extension", () => {
	test("opens Plannotator and sends feedback to the agent", async () => {
		const harness = createHarness();
		await harness.run("uncommitted");

		expect(harness.openCalls).toEqual([{ cwd: "/tmp/project", diffType: "uncommitted", vcsType: "git" }]);
		expect(harness.sentUserMessages).toEqual([
			{ message: "Please fix the error handling.", options: undefined },
		]);
		expect(harness.notifications).toContainEqual({
			message: "Sent review feedback to the agent.",
			level: "info",
		});
	});

	test("queues feedback as a follow-up when the agent is busy", async () => {
		const harness = createHarness({ isIdle: false });
		await harness.run("uncommitted");

		expect(harness.sentUserMessages).toEqual([
			{ message: "Please fix the error handling.", options: { deliverAs: "followUp" } },
		]);
	});

	test("uses the preserved unborn-repository review when HEAD is missing", async () => {
		const harness = createHarness({ hasHeadCommit: false });
		await harness.run("uncommitted");

		expect(harness.openCalls).toEqual([]);
		expect(harness.unbornOpenCalls).toEqual(["/tmp/project"]);
	});

	test("does not send anything when the review is approved", async () => {
		const harness = createHarness({ result: { approved: true, feedback: "Optional approval note." } });
		await harness.run();
		expect(harness.sentUserMessages).toEqual([]);
		expect(harness.notifications).toContainEqual({ message: "Diff review approved.", level: "info" });
	});

	test("does not send feedback when the browser is closed", async () => {
		const harness = createHarness({ result: { approved: false, exit: true } });
		await harness.run();
		expect(harness.sentUserMessages).toEqual([]);
		expect(harness.notifications).toContainEqual({ message: "Diff review closed.", level: "info" });
	});

	test("fails outside git repositories", async () => {
		const harness = createHarness({ isGitRepository: false });
		await harness.run();
		expect(harness.openCalls).toEqual([]);
		expect(harness.notifications).toContainEqual({
			message: "This command only works inside a git repository.",
			level: "error",
		});
	});

	test("reports Plannotator startup failures", async () => {
		const harness = createHarness({ openError: new Error("Browser unavailable") });
		await harness.run();
		expect(harness.notifications).toContainEqual({ message: "Browser unavailable", level: "error" });
	});
});
