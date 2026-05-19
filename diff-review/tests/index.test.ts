import { describe, expect, test } from "vitest";
import { createDiffReviewExtension } from "../index";

type Handler = (args: string, ctx: any) => Promise<void>;

function createHarness(options?: {
	isGitRepository?: boolean;
	target?: any;
	reviewData?: any;
	openCode?: number;
}) {
	const commands = new Map<string, Handler>();
	const shutdownHandlers: Array<() => Promise<void>> = [];
	const notifications: Array<{ message: string; level?: string }> = [];
	const serverSessions: Array<{ bootstrap: any; url: string }> = [];
	const openCalls: Array<{ url: string }> = [];
	let createServerCount = 0;
	let stopCount = 0;

	const server = {
		async createReviewSession(input: any) {
			serverSessions.push({ bootstrap: input.bootstrap, url: `http://127.0.0.1:1234/review/${serverSessions.length + 1}` });
			return { token: `00000000-0000-4000-8000-${String(serverSessions.length + 1).padStart(12, "0")}`, url: serverSessions.at(-1)!.url };
		},
		async stop() {
			stopCount += 1;
		},
	};

	const extension = createDiffReviewExtension({
		createServer: () => {
			createServerCount += 1;
			return server as any;
		},
		isGitRepository: async () => options?.isGitRepository ?? true,
		resolveDiffTargetFromArgs: async () => options?.target ?? { type: "uncommitted" },
		buildDiffReviewData: async () =>
			options?.reviewData ?? {
				repo: { root: "/tmp/project", name: "project", cwd: "/tmp/project" },
				target: {
					type: "uncommitted",
					label: "Uncommitted changes",
					subtitle: "Working tree compared with HEAD",
					baseRev: "HEAD",
					headRev: "HEAD",
					hasHead: true,
				},
				files: [],
				filePayloads: new Map(),
			},
		openInDefaultBrowser: async (_pi, _cwd, url) => {
			openCalls.push({ url });
			return { stdout: "", stderr: "", code: options?.openCode ?? 0 } as any;
		},
	});

	const pi = {
		registerCommand(name: string, command: { handler: Handler }) {
			commands.set(name, command.handler);
		},
		on(name: string, handler: () => Promise<void>) {
			if (name === "session_shutdown") {
				shutdownHandlers.push(handler);
			}
		},
	} as any;
	const ctx = {
		hasUI: true,
		cwd: "/tmp/project",
		ui: {
			notify: (message: string, level?: string) => notifications.push({ message, level }),
			getEditorText: () => "",
			setEditorText: () => {},
		},
	} as any;

	extension(pi);

	return {
		async run(commandName: string, args = "") {
			const handler = commands.get(commandName);
			if (!handler) {
				throw new Error(`Missing handler for ${commandName}`);
			}
			await handler(args, ctx);
		},
		async shutdown() {
			await Promise.all(shutdownHandlers.map((handler) => handler()));
		},
		notifications,
		serverSessions,
		openCalls,
		getCreateServerCount: () => createServerCount,
		getStopCount: () => stopCount,
	};
}

describe("diff-review extension", () => {
	test("registers the command and opens a browser review", async () => {
		const harness = createHarness();
		await harness.run("diff-review", "uncommitted");
		expect(harness.openCalls).toEqual([{ url: "http://127.0.0.1:1234/review/1" }]);
		expect(harness.notifications).toContainEqual({
			message: "Opened diff review for Uncommitted changes.",
			level: "success",
		});
	});

	test("reuses the server across invocations", async () => {
		const harness = createHarness();
		await harness.run("diff-review", "uncommitted");
		await harness.run("diff-review", "commit abc123");
		expect(harness.getCreateServerCount()).toBe(1);
		expect(harness.openCalls).toEqual([
			{ url: "http://127.0.0.1:1234/review/1" },
			{ url: "http://127.0.0.1:1234/review/2" },
		]);
	});

	test("fails outside git repositories", async () => {
		const harness = createHarness({ isGitRepository: false });
		await harness.run("diff-review", "uncommitted");
		expect(harness.notifications).toContainEqual({
			message: "This command only works inside a git repository.",
			level: "error",
		});
	});

	test("surfaces browser open failures", async () => {
		const harness = createHarness({ openCode: 1 });
		await harness.run("diff-review", "uncommitted");
		expect(harness.notifications).toContainEqual({
			message: "Failed to open the diff review in the default browser. Open it manually: http://127.0.0.1:1234/review/1",
			level: "error",
		});
	});

	test("stops the server on session shutdown", async () => {
		const harness = createHarness();
		await harness.run("diff-review", "uncommitted");
		await harness.shutdown();
		expect(harness.getStopCount()).toBe(1);
	});
});
