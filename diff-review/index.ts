import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendCommentsToEditor } from "./comments";
import { openCmuxPane, openCmuxSurface, resolveCmuxCallerContext, type CmuxCallerContext } from "./cmux";
import { buildDiffReviewData, isGitRepository } from "./git";
import { isGlimpseInstalled, openInDefaultBrowser, openInGlimpse } from "./opener";
import { createDiffReviewServer, type DiffReviewServer } from "./server";
import { resolveDiffTargetFromArgs } from "./target-selector";
import type { DiffComment, DiffViewMode, SendCommentsResponse } from "./types";

export type DiffReviewExtensionDependencies = {
	createServer: () => DiffReviewServer;
	isGitRepository: typeof isGitRepository;
	resolveDiffTargetFromArgs: typeof resolveDiffTargetFromArgs;
	buildDiffReviewData: typeof buildDiffReviewData;
	resolveCmuxCallerContext: typeof resolveCmuxCallerContext;
	openCmuxPane: typeof openCmuxPane;
	openCmuxSurface: typeof openCmuxSurface;
	isGlimpseInstalled: typeof isGlimpseInstalled;
	openInDefaultBrowser: typeof openInDefaultBrowser;
	openInGlimpse: typeof openInGlimpse;
	appendCommentsToEditor: typeof appendCommentsToEditor;
};

type ReviewOpenTarget =
	| { kind: "browser" }
	| { kind: "glimpse" }
	| { kind: "cmuxPane"; workspaceId: string }
	| { kind: "cmuxSurface"; workspaceId: string; paneRef: string };

const REVIEW_COMMAND = "diff-review";
const OPEN_IN_CMUX_SURFACE_LABEL = "cmux Surface";
const OPEN_IN_CMUX_PANE_LABEL = "cmux Pane (right)";
const OPEN_IN_GLIMPSE_LABEL = "Glimpse";
const OPEN_IN_BROWSER_LABEL = "Default Browser";

function notify(ctx: ExtensionContext, message: string, level: "info" | "error" | "success" = "info") {
	if (ctx.hasUI) {
		ctx.ui.notify(message, level);
	}
}

function createDefaultDependencies(): DiffReviewExtensionDependencies {
	return {
		createServer: () => createDiffReviewServer(),
		isGitRepository,
		resolveDiffTargetFromArgs,
		buildDiffReviewData,
		resolveCmuxCallerContext,
		openCmuxPane,
		openCmuxSurface,
		isGlimpseInstalled,
		openInDefaultBrowser,
		openInGlimpse,
		appendCommentsToEditor,
	};
}

async function selectOpenTarget(ctx: ExtensionContext, cmuxContext: CmuxCallerContext | null, glimpseAvailable: boolean): Promise<ReviewOpenTarget | null> {
	if (!cmuxContext && !glimpseAvailable) {
		return { kind: "browser" };
	}

	const labels = [
		...(cmuxContext ? [OPEN_IN_CMUX_SURFACE_LABEL, OPEN_IN_CMUX_PANE_LABEL] : []),
		...(glimpseAvailable ? [OPEN_IN_GLIMPSE_LABEL] : []),
		OPEN_IN_BROWSER_LABEL,
	];
	const selection = await ctx.ui.select("Open in...", labels);
	if (selection === undefined) {
		return null;
	}
	if (selection === OPEN_IN_BROWSER_LABEL) {
		return { kind: "browser" };
	}
	if (selection === OPEN_IN_GLIMPSE_LABEL) {
		return { kind: "glimpse" };
	}
	if (selection === OPEN_IN_CMUX_PANE_LABEL && cmuxContext) {
		return { kind: "cmuxPane", workspaceId: cmuxContext.workspaceId };
	}
	if (selection === OPEN_IN_CMUX_SURFACE_LABEL && cmuxContext) {
		if (!cmuxContext.callerPaneRef) {
			ctx.ui.notify("Could not determine the current cmux pane. Choose cmux Pane (right) or Default Browser instead.", "error");
			return null;
		}
		return { kind: "cmuxSurface", workspaceId: cmuxContext.workspaceId, paneRef: cmuxContext.callerPaneRef };
	}
	return null;
}

async function openReviewTarget(
	dependencies: DiffReviewExtensionDependencies,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	openTarget: ReviewOpenTarget,
	url: string,
) {
	switch (openTarget.kind) {
		case "browser":
			return await dependencies.openInDefaultBrowser(pi, ctx.cwd, url);
		case "glimpse":
			return await dependencies.openInGlimpse(pi, ctx.cwd, url);
		case "cmuxPane":
			return await dependencies.openCmuxPane(pi, ctx.cwd, openTarget.workspaceId, url);
		case "cmuxSurface":
			return await dependencies.openCmuxSurface(pi, ctx.cwd, openTarget.workspaceId, openTarget.paneRef, url);
	}
}

function getOpenFailureMessage(openTarget: ReviewOpenTarget, stderr: string, url: string): string {
	const reason = stderr.trim();
	if (reason) {
		return `${reason} Open it manually: ${url}`;
	}
	if (openTarget.kind === "browser") {
		return `Failed to open the diff review in the default browser. Open it manually: ${url}`;
	}
	if (openTarget.kind === "glimpse") {
		return `Failed to open the diff review in Glimpse. Open it manually: ${url}`;
	}
	return `Failed to open the diff review in cmux. Open it manually: ${url}`;
}

export function createDiffReviewExtension(overrides: Partial<DiffReviewExtensionDependencies> = {}) {
	const dependencies = { ...createDefaultDependencies(), ...overrides } satisfies DiffReviewExtensionDependencies;

	return function (pi: ExtensionAPI) {
		let runtimeServer: DiffReviewServer | null = null;

		const ensureServer = () => {
			if (!runtimeServer) {
				runtimeServer = dependencies.createServer();
			}
			return runtimeServer;
		};

		const handleCommand = async (args: string, ctx: ExtensionContext) => {
			if (!ctx.hasUI) {
				return;
			}

			if (!(await dependencies.isGitRepository(pi, ctx.cwd))) {
				notify(ctx, "This command only works inside a git repository.", "error");
				return;
			}

			const target = await dependencies.resolveDiffTargetFromArgs(pi, ctx, args);
			if (!target) {
				return;
			}

			try {
				const [cmuxContext, glimpseAvailable] = await Promise.all([
					dependencies.resolveCmuxCallerContext(pi, ctx.cwd),
					dependencies.isGlimpseInstalled(pi, ctx.cwd),
				]);
				const openTarget = await selectOpenTarget(ctx, cmuxContext, glimpseAvailable);
				if (!openTarget) {
					return;
				}

				let reviewData = await dependencies.buildDiffReviewData(pi, ctx.cwd, target);
				let hasServedInitialBootstrap = false;
				const defaultViewMode: DiffViewMode = openTarget.kind === "cmuxSurface" ? "split" : "unified";
				const server = ensureServer();
				const session = await server.createReviewSession({
					bootstrap: {
						repo: reviewData.repo,
						target: reviewData.target,
						files: reviewData.files,
						defaultViewMode,
					},
					refreshBootstrap: async () => {
						if (!hasServedInitialBootstrap) {
							hasServedInitialBootstrap = true;
							return {
								repo: reviewData.repo,
								target: reviewData.target,
								files: reviewData.files,
								defaultViewMode,
							};
						}
						reviewData = await dependencies.buildDiffReviewData(pi, ctx.cwd, target);
						return {
							repo: reviewData.repo,
							target: reviewData.target,
							files: reviewData.files,
							defaultViewMode,
						};
					},
					loadFile: async (fileId) => reviewData.filePayloads.get(fileId) ?? null,
					sendComments: async (comments: DiffComment[]): Promise<SendCommentsResponse> => {
						const formattedText = await dependencies.appendCommentsToEditor(ctx.ui, reviewData.target, comments);
						return {
							sentAt: Date.now(),
							formattedText,
						};
					},
				});

				const openResult = await openReviewTarget(dependencies, pi, ctx, openTarget, session.url);
				if (openResult.code !== 0) {
					notify(ctx, getOpenFailureMessage(openTarget, openResult.stderr, session.url), "error");
					return;
				}
				notify(ctx, `Opened diff review for ${reviewData.target.label}.`, "success");
			} catch (error) {
				const message = error instanceof Error ? error.message : "Failed to open the diff review.";
				notify(ctx, message, "error");
			}
		};

		pi.registerCommand(REVIEW_COMMAND, {
			description: "Open a browser diff review",
			handler: async (args, ctx) => {
				await handleCommand(args, ctx);
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

export default createDiffReviewExtension();
