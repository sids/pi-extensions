import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { appendCommentsToEditor } from "./comments";
import { openCmuxPane, openCmuxSurface, resolveCmuxCallerContext } from "./cmux";
import { buildDiffViewerData, isGitRepository } from "./git";
import { createDiffCmuxServer, type DiffCmuxServer } from "./server";
import { resolveDiffTargetFromArgs } from "./target-selector";
import type { DiffComment, DiffViewMode, SendCommentsResponse } from "./types";

export type DiffCmuxExtensionDependencies = {
	createServer: () => DiffCmuxServer;
	isGitRepository: typeof isGitRepository;
	resolveCmuxCallerContext: typeof resolveCmuxCallerContext;
	resolveDiffTargetFromArgs: typeof resolveDiffTargetFromArgs;
	buildDiffViewerData: typeof buildDiffViewerData;
	openCmuxPane: typeof openCmuxPane;
	openCmuxSurface: typeof openCmuxSurface;
	appendCommentsToEditor: typeof appendCommentsToEditor;
};

const PANE_COMMAND = "diff-cmux-pane";
const SURFACE_COMMAND = "diff-cmux-surface";

function notify(ctx: ExtensionContext, message: string, level: "info" | "error" | "success" = "info") {
	if (ctx.hasUI) {
		ctx.ui.notify(message, level);
	}
}

function createDefaultDependencies(): DiffCmuxExtensionDependencies {
	return {
		createServer: () => createDiffCmuxServer(),
		isGitRepository,
		resolveCmuxCallerContext,
		resolveDiffTargetFromArgs,
		buildDiffViewerData,
		openCmuxPane,
		openCmuxSurface,
		appendCommentsToEditor,
	};
}

export function createDiffCmuxExtension(overrides: Partial<DiffCmuxExtensionDependencies> = {}) {
	const dependencies = { ...createDefaultDependencies(), ...overrides } satisfies DiffCmuxExtensionDependencies;

	return function (pi: ExtensionAPI) {
		let runtimeServer: DiffCmuxServer | null = null;

		const ensureServer = () => {
			if (!runtimeServer) {
				runtimeServer = dependencies.createServer();
			}
			return runtimeServer;
		};

		const handleCommand = async (kind: "pane" | "surface", args: string, ctx: ExtensionContext) => {
			if (!ctx.hasUI) {
				return;
			}

			if (!(await dependencies.isGitRepository(pi, ctx.cwd))) {
				notify(ctx, "This command only works inside a git repository.", "error");
				return;
			}

			const cmuxContext = await dependencies.resolveCmuxCallerContext(pi, ctx.cwd);
			if (!cmuxContext?.workspaceId) {
				notify(ctx, "cmux context not found. Run this command inside cmux.", "error");
				return;
			}
			if (kind === "surface" && !cmuxContext.callerPaneRef) {
				notify(ctx, "Could not determine the current cmux pane. Try again from an active pane.", "error");
				return;
			}

			const target = await dependencies.resolveDiffTargetFromArgs(pi, ctx, args);
			if (!target) {
				return;
			}

			try {
				let viewerData = await dependencies.buildDiffViewerData(pi, ctx.cwd, target);
				let hasServedInitialBootstrap = false;
				const defaultViewMode: DiffViewMode = kind === "pane" ? "unified" : "split";
				const server = ensureServer();
				const session = await server.createViewerSession({
					bootstrap: {
						repo: viewerData.repo,
						target: viewerData.target,
						files: viewerData.files,
						defaultViewMode,
					},
					refreshBootstrap: async () => {
						if (!hasServedInitialBootstrap) {
							hasServedInitialBootstrap = true;
							return {
								repo: viewerData.repo,
								target: viewerData.target,
								files: viewerData.files,
								defaultViewMode,
							};
						}
						viewerData = await dependencies.buildDiffViewerData(pi, ctx.cwd, target);
						return {
							repo: viewerData.repo,
							target: viewerData.target,
							files: viewerData.files,
							defaultViewMode,
						};
					},
					loadFile: async (fileId) => viewerData.filePayloads.get(fileId) ?? null,
					sendComments: async (comments: DiffComment[]): Promise<SendCommentsResponse> => {
						const formattedText = await dependencies.appendCommentsToEditor(ctx.ui, viewerData.target, comments);
						return {
							sentAt: Date.now(),
							formattedText,
						};
					},
				});

				const openResult =
					kind === "pane"
						? await dependencies.openCmuxPane(pi, ctx.cwd, cmuxContext.workspaceId, session.url)
						: await dependencies.openCmuxSurface(pi, ctx.cwd, cmuxContext.workspaceId, cmuxContext.callerPaneRef!, session.url);
				if (openResult.code !== 0) {
					notify(ctx, openResult.stderr.trim() || "Failed to open the diff viewer in cmux.", "error");
					return;
				}
				notify(ctx, `Opened diff viewer for ${viewerData.target.label}.`, "success");
			} catch (error) {
				const message = error instanceof Error ? error.message : "Failed to open the diff viewer.";
				notify(ctx, message, "error");
			}
		};

		pi.registerCommand(PANE_COMMAND, {
			description: "Open a diff viewer in a new cmux browser pane",
			handler: async (args, ctx) => {
				await handleCommand("pane", args, ctx);
			},
		});

		pi.registerCommand(SURFACE_COMMAND, {
			description: "Open a diff viewer in a cmux browser surface",
			handler: async (args, ctx) => {
				await handleCommand("surface", args, ctx);
			},
		});

		pi.on("session_shutdown", async () => {
			if (runtimeServer) {
				await runtimeServer.stop();
				runtimeServer = null;
			}
		});
	};
}

export default createDiffCmuxExtension();
