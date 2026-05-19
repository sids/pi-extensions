import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendCommentsToEditor } from "./comments";
import { buildDiffReviewData, isGitRepository } from "./git";
import { openInDefaultBrowser } from "./opener";
import { createDiffReviewServer, type DiffReviewServer } from "./server";
import { resolveDiffTargetFromArgs } from "./target-selector";
import type { DiffComment, DiffViewMode, SendCommentsResponse } from "./types";

export type DiffReviewExtensionDependencies = {
	createServer: () => DiffReviewServer;
	isGitRepository: typeof isGitRepository;
	resolveDiffTargetFromArgs: typeof resolveDiffTargetFromArgs;
	buildDiffReviewData: typeof buildDiffReviewData;
	openInDefaultBrowser: typeof openInDefaultBrowser;
	appendCommentsToEditor: typeof appendCommentsToEditor;
};

const REVIEW_COMMAND = "diff-review";

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
		openInDefaultBrowser,
		appendCommentsToEditor,
	};
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
				let reviewData = await dependencies.buildDiffReviewData(pi, ctx.cwd, target);
				let hasServedInitialBootstrap = false;
				const defaultViewMode: DiffViewMode = "unified";
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

				const openResult = await dependencies.openInDefaultBrowser(pi, ctx.cwd, session.url);
				if (openResult.code !== 0) {
					const reason = openResult.stderr.trim() || "Failed to open the diff review in the default browser.";
					notify(ctx, `${reason} Open it manually: ${session.url}`, "error");
					return;
				}
				notify(ctx, `Opened diff review for ${reviewData.target.label}.`, "success");
			} catch (error) {
				const message = error instanceof Error ? error.message : "Failed to open the diff review.";
				notify(ctx, message, "error");
			}
		};

		pi.registerCommand(REVIEW_COMMAND, {
			description: "Open a diff review in the default browser",
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
