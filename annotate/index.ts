import { existsSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getLastAssistantMessageSnapshot } from "@plannotator/pi-extension/assistant-message.ts";
import { loadConfig } from "@plannotator/pi-extension/generated/config.ts";
import {
	getAnnotateFileFeedbackPrompt,
} from "@plannotator/pi-extension/generated/prompts.ts";
import { FILE_BROWSER_EXCLUDED } from "@plannotator/pi-extension/generated/reference-common.ts";
import {
	getAnnotatableDocRegex,
	getAnnotatableExtensionsHint,
	hasMarkdownFiles,
	isAnnotatableTextPath,
	MAX_ANNOTATABLE_FILE_BYTES,
	resolveUserPath,
} from "@plannotator/pi-extension/generated/resolve-file.ts";
import {
	getStartupErrorMessage,
	startLastMessageAnnotationSession,
	startMarkdownAnnotationSession,
} from "@plannotator/pi-extension/plannotator-events.ts";
import { isTuiMode } from "@siddr/pi-shared-qna/extension-mode";
import {
	handlePlannotatorDecision,
	registerPlannotatorFeedbackRenderer,
} from "@siddr/pi-shared-qna/plannotator-feedback";
import {
	preparePlannotatorBrowserSession,
	preparePlannotatorContext,
} from "@siddr/pi-shared-qna/plannotator-url";

export type AnnotationSession = Awaited<ReturnType<typeof startLastMessageAnnotationSession>>;
export type AnnotationDecision = Awaited<ReturnType<AnnotationSession["waitForDecision"]>>;

export type AnnotationRequest =
	| {
		kind: "message";
		message: string;
		assistantEntryId: string;
	}
	| {
		kind: "file";
		filePath: string;
		markdown: string;
		sourceInfo?: string;
		rawHtml?: string;
	}
	| {
		kind: "folder";
		folderPath: string;
	};

export type StartAnnotation = (
	ctx: ExtensionContext,
	request: AnnotationRequest,
) => Promise<AnnotationSession>;

export type AnnotateExtensionDependencies = {
	startAnnotation: StartAnnotation;
};

type AnnotationOrigin = {
	sessionId: string;
	leafId: string | null;
	assistantEntryId?: string;
};

export async function startAnnotationInBrowser(
	ctx: ExtensionContext,
	request: AnnotationRequest,
): Promise<AnnotationSession> {
	try {
		const plannotatorCtx = await preparePlannotatorContext(ctx);
		const session = request.kind === "message"
			? await startLastMessageAnnotationSession(plannotatorCtx, request.message)
			: request.kind === "folder"
				? await startMarkdownAnnotationSession(
					plannotatorCtx,
					request.folderPath,
					"",
					"annotate-folder",
					request.folderPath,
				)
				: await startMarkdownAnnotationSession(
					plannotatorCtx,
					request.filePath,
					request.markdown,
					"annotate",
					undefined,
					request.sourceInfo,
					false,
					undefined,
					request.rawHtml,
					request.rawHtml !== undefined,
				);
		return await preparePlannotatorBrowserSession(plannotatorCtx, session);
	} catch (error) {
		throw new Error(`Failed to open annotation: ${getStartupErrorMessage(error)}`);
	}
}

function isCurrentOrigin(ctx: ExtensionContext, origin: AnnotationOrigin): boolean {
	try {
		if (
			ctx.sessionManager.getSessionId() !== origin.sessionId
			|| ctx.sessionManager.getLeafId() !== origin.leafId
		) {
			return false;
		}
		return !origin.assistantEntryId
			|| ctx.sessionManager.getBranch().some((entry) => entry.id === origin.assistantEntryId);
	} catch {
		return false;
	}
}

function notify(
	ctx: ExtensionContext,
	message: string,
	level: "info" | "warning" | "error" = "info",
): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, level);
	}
}

function resolvePathInput(args: string, cwd: string): string {
	const input = args.trim();
	const direct = resolveUserPath(input, cwd);
	if (existsSync(direct) || !input.startsWith("@")) return direct;
	return resolveUserPath(input.slice(1), cwd);
}

export function resolveAnnotationRequest(
	ctx: ExtensionContext,
	args: string,
): AnnotationRequest | undefined {
	if (!args.trim()) return undefined;
	const targetPath = resolvePathInput(args, ctx.cwd);
	if (!existsSync(targetPath)) {
		throw new Error(`File or folder not found: ${targetPath}`);
	}

	let stat;
	try {
		stat = statSync(targetPath);
	} catch {
		throw new Error(`Cannot access: ${targetPath}`);
	}
	if (stat.isDirectory()) {
		if (!hasMarkdownFiles(targetPath, FILE_BROWSER_EXCLUDED, getAnnotatableDocRegex())) {
			throw new Error(`No annotatable files found in ${targetPath}`);
		}
		return { kind: "folder", folderPath: targetPath };
	}
	if (!stat.isFile()) {
		throw new Error(`Cannot annotate this path: ${targetPath}`);
	}
	if (!isAnnotatableTextPath(targetPath)) {
		throw new Error(`File type not supported. Supported types: ${getAnnotatableExtensionsHint()}`);
	}
	if (stat.size > MAX_ANNOTATABLE_FILE_BYTES) {
		throw new Error(`File too large to annotate (max 2MB): ${targetPath}`);
	}
	if (/\.html?$/i.test(targetPath)) {
		return {
			kind: "file",
			filePath: targetPath,
			markdown: "",
			sourceInfo: basename(targetPath),
			rawHtml: readFileSync(targetPath, "utf8"),
		};
	}
	return {
		kind: "file",
		filePath: targetPath,
		markdown: readFileSync(targetPath, "utf8"),
	};
}

function prepareDecision(request: AnnotationRequest, decision: AnnotationDecision): AnnotationDecision {
	const feedback = decision.feedback?.trim();
	if (!feedback || request.kind === "message") return decision;
	const isFolder = request.kind === "folder";
	const filePath = isFolder ? request.folderPath : request.filePath;
	return {
		...decision,
		feedback: getAnnotateFileFeedbackPrompt("pi", loadConfig(), {
			fileHeader: isFolder ? "Folder" : "File",
			filePath,
			feedback,
		}),
	};
}

function decisionNotifications(request: AnnotationRequest) {
	return request.kind === "message"
		? {
			approved: "Message approved.",
			closed: "Annotation closed.",
			empty: "Annotation closed without feedback.",
			sent: "Sent annotation feedback to the agent.",
		}
		: {
			approved: "Annotation approved.",
			closed: "Annotation closed.",
			empty: "Annotation closed without feedback.",
			sent: "Sent annotation feedback to the agent.",
		};
}

export function createAnnotateExtension(overrides: Partial<AnnotateExtensionDependencies> = {}) {
	const dependencies = {
		startAnnotation: startAnnotationInBrowser,
		...overrides,
	} satisfies AnnotateExtensionDependencies;

	return function annotateExtension(pi: ExtensionAPI): void {
		const activeSessions = new Set<AnnotationSession>();
		let shuttingDown = false;
		const handleSession = async (
			session: AnnotationSession,
			ctx: ExtensionContext,
			origin: AnnotationOrigin,
			request: AnnotationRequest,
		) => {
			try {
				const decision = await session.waitForDecision();
				if (!isCurrentOrigin(ctx, origin)) {
					notify(ctx, "Annotation feedback was not sent because the conversation moved.", "warning");
					return;
				}
				await handlePlannotatorDecision(pi, ctx, prepareDecision(request, decision), {
					notifications: decisionNotifications(request),
				});
			} catch (error) {
				if (!shuttingDown && isCurrentOrigin(ctx, origin)) {
					const message = error instanceof Error ? error.message : "Annotation session failed.";
					notify(ctx, message, "error");
				}
			} finally {
				activeSessions.delete(session);
			}
		};

		registerPlannotatorFeedbackRenderer(pi);
		pi.registerCommand("annotate", {
			description: "Annotate the last assistant message, a file, or a folder in Plannotator",
			handler: async (args, ctx) => {
				if (!isTuiMode(ctx)) {
					notify(ctx, "Annotation is only available in TUI mode.", "error");
					return;
				}

				await ctx.waitForIdle();
				let request: AnnotationRequest;
				try {
					const pathRequest = resolveAnnotationRequest(ctx, args);
					if (pathRequest) {
						request = pathRequest;
					} else {
						const snapshot = getLastAssistantMessageSnapshot(ctx);
						if (!snapshot) {
							notify(ctx, "No assistant message found in this session.", "error");
							return;
						}
						request = {
							kind: "message",
							message: snapshot.text,
							assistantEntryId: snapshot.entryId,
						};
					}
					const origin: AnnotationOrigin = {
						sessionId: ctx.sessionManager.getSessionId(),
						leafId: ctx.sessionManager.getLeafId(),
						...(request.kind === "message" ? { assistantEntryId: request.assistantEntryId } : {}),
					};
					const session = await dependencies.startAnnotation(ctx, request);
					activeSessions.add(session);
					void handleSession(session, ctx, origin, request);
				} catch (error) {
					const message = error instanceof Error ? error.message : "Failed to open annotation.";
					notify(ctx, message, "error");
				}
			},
		});

		pi.on("session_shutdown", () => {
			shuttingDown = true;
			for (const session of activeSessions) {
				session.stop();
			}
			activeSessions.clear();
		});
	};
}

export default createAnnotateExtension();
