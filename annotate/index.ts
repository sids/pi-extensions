import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getLastAssistantMessageSnapshot } from "@plannotator/pi-extension/assistant-message.ts";
import {
	getStartupErrorMessage,
	startLastMessageAnnotationSession,
} from "@plannotator/pi-extension/plannotator-events.ts";
import { isTuiMode } from "@siddr/pi-shared-qna/extension-mode";
import {
	handlePlannotatorDecision,
	registerPlannotatorFeedbackRenderer,
} from "@siddr/pi-shared-qna/plannotator-feedback";
import { preparePlannotatorContext } from "@siddr/pi-shared-qna/plannotator-url";

export type AnnotationSession = Awaited<ReturnType<typeof startLastMessageAnnotationSession>>;
export type AnnotationDecision = Awaited<ReturnType<AnnotationSession["waitForDecision"]>>;

export type StartAnnotation = (
	ctx: ExtensionContext,
	message: string,
) => Promise<AnnotationSession>;

export type AnnotateExtensionDependencies = {
	startAnnotation: StartAnnotation;
};

type AnnotationOrigin = {
	sessionId: string;
	leafId: string | null;
	assistantEntryId: string;
};

export async function startAnnotationInBrowser(
	ctx: ExtensionContext,
	message: string,
): Promise<AnnotationSession> {
	try {
		const plannotatorCtx = await preparePlannotatorContext(ctx);
		return await startLastMessageAnnotationSession(plannotatorCtx, message);
	} catch (error) {
		throw new Error(`Failed to open annotation: ${getStartupErrorMessage(error)}`);
	}
}

function isCurrentOrigin(ctx: ExtensionContext, origin: AnnotationOrigin): boolean {
	try {
		return ctx.sessionManager.getSessionId() === origin.sessionId
			&& ctx.sessionManager.getLeafId() === origin.leafId
			&& ctx.sessionManager.getBranch().some((entry) => entry.id === origin.assistantEntryId);
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
		) => {
			try {
				const decision = await session.waitForDecision();
				if (!isCurrentOrigin(ctx, origin)) {
					notify(ctx, "Annotation feedback was not sent because the conversation moved.", "warning");
					return;
				}
				await handlePlannotatorDecision(pi, ctx, decision, {
					notifications: {
						approved: "Message approved.",
						closed: "Annotation closed.",
						empty: "Annotation closed without feedback.",
						sent: "Sent annotation feedback to the agent.",
					},
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
			description: "Annotate the last assistant message in Plannotator",
			handler: async (_args, ctx) => {
				if (!isTuiMode(ctx)) {
					notify(ctx, "Annotation is only available in TUI mode.", "error");
					return;
				}

				await ctx.waitForIdle();
				const snapshot = getLastAssistantMessageSnapshot(ctx);
				if (!snapshot) {
					notify(ctx, "No assistant message found in this session.", "error");
					return;
				}

				const origin: AnnotationOrigin = {
					sessionId: ctx.sessionManager.getSessionId(),
					leafId: ctx.sessionManager.getLeafId(),
					assistantEntryId: snapshot.entryId,
				};
				try {
					const session = await dependencies.startAnnotation(ctx, snapshot.text);
					activeSessions.add(session);
					void handleSession(session, ctx, origin);
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
