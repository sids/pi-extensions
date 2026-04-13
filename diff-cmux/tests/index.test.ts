import { describe, expect, test } from "bun:test";
import { createDiffCmuxExtension } from "../index";

type Handler = (args: string, ctx: any) => Promise<void>;

function createHarness(options?: {
	isGitRepository?: boolean;
	cmuxContext?: { workspaceId: string; callerPaneRef: string | null } | null;
	target?: any;
	viewerData?: any;
	openPaneCode?: number;
}) {
	const commands = new Map<string, Handler>();
	const notifications: Array<{ message: string; level?: string }> = [];
	const serverSessions: Array<{ bootstrap: any; url: string }> = [];
	const openPaneCalls: Array<{ workspaceId: string; url: string }> = [];
	const openSurfaceCalls: Array<{ workspaceId: string; paneRef: string; url: string }> = [];
	let createServerCount = 0;
	let stopCount = 0;

	const server = {
		async createViewerSession(input: any) {
			serverSessions.push({ bootstrap: input.bootstrap, url: `http://127.0.0.1:1234/viewer/${serverSessions.length + 1}` });
			return { token: `00000000-0000-4000-8000-${String(serverSessions.length + 1).padStart(12, "0")}`, url: serverSessions.at(-1)!.url };
		},
		async stop() {
			stopCount += 1;
		},
	};

	const extension = createDiffCmuxExtension({
		createServer: () => {
			createServerCount += 1;
			return server as any;
		},
		isGitRepository: async () => options?.isGitRepository ?? true,
		resolveCmuxCallerContext: async () => options?.cmuxContext ?? { workspaceId: "workspace:1", callerPaneRef: "pane:current" },
		resolveDiffTargetFromArgs: async () => options?.target ?? { type: "uncommitted" },
		buildDiffViewerData: async () =>
			options?.viewerData ?? {
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
		openCmuxPane: async (_pi, _cwd, workspaceId, url) => {
			openPaneCalls.push({ workspaceId, url });
			return { stdout: "", stderr: "", code: options?.openPaneCode ?? 0 } as any;
		},
		openCmuxSurface: async (_pi, _cwd, workspaceId, paneRef, url) => {
			openSurfaceCalls.push({ workspaceId, paneRef, url });
			return { stdout: "", stderr: "", code: 0 } as any;
		},
	});

	const pi = {
		registerCommand(name: string, command: { handler: Handler }) {
			commands.set(name, command.handler);
		},
		on() {},
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
		notifications,
		serverSessions,
		openPaneCalls,
		openSurfaceCalls,
		getCreateServerCount: () => createServerCount,
		getStopCount: () => stopCount,
	};
}

describe("diff-cmux extension", () => {
	test("registers both commands and opens a pane viewer", async () => {
		const harness = createHarness();
		await harness.run("diff-cmux-pane", "uncommitted");
		expect(harness.openPaneCalls).toEqual([
			{
				workspaceId: "workspace:1",
				url: "http://127.0.0.1:1234/viewer/1",
			},
		]);
		expect(harness.notifications).toContainEqual({
			message: "Opened diff viewer for Uncommitted changes.",
			level: "success",
		});
	});

	test("reuses the server across invocations", async () => {
		const harness = createHarness();
		await harness.run("diff-cmux-pane", "uncommitted");
		await harness.run("diff-cmux-surface", "commit abc123");
		expect(harness.getCreateServerCount()).toBe(1);
		expect(harness.openSurfaceCalls).toEqual([
			{
				workspaceId: "workspace:1",
				paneRef: "pane:current",
				url: "http://127.0.0.1:1234/viewer/2",
			},
		]);
	});

	test("fails outside git repositories", async () => {
		const harness = createHarness({ isGitRepository: false });
		await harness.run("diff-cmux-pane", "uncommitted");
		expect(harness.notifications).toContainEqual({
			message: "This command only works inside a git repository.",
			level: "error",
		});
	});

	test("requires a pane ref for surface viewers", async () => {
		const harness = createHarness({ cmuxContext: { workspaceId: "workspace:1", callerPaneRef: null } });
		await harness.run("diff-cmux-surface", "uncommitted");
		expect(harness.notifications).toContainEqual({
			message: "Could not determine the current cmux pane. Try again from an active pane.",
			level: "error",
		});
	});

	test("surfaces cmux open failures", async () => {
		const harness = createHarness({ openPaneCode: 1 });
		await harness.run("diff-cmux-pane", "uncommitted");
		expect(harness.notifications).toContainEqual({
			message: "Failed to open the diff viewer in cmux.",
			level: "error",
		});
	});
});
