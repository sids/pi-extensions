import { existsSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getLastAssistantMessageSnapshot } from "@plannotator/pi-extension/assistant-message.ts";
import {
	loadConfig,
	resolveUseJina,
} from "@plannotator/pi-extension/generated/config.ts";
import { parseAnnotateArgs } from "@plannotator/pi-extension/generated/annotate-args.ts";
import {
	buildForceAppFailureMessage,
	buildLiveProbeFallbackNotice,
	classifyLiveAppCandidate,
	LIVE_APP_REMOTE_MESSAGE,
	LIVE_APP_REQUIRES_HTTP_MESSAGE,
	LIVE_APP_REQUIRES_LOOPBACK_MESSAGE,
	LIVE_APP_REQUIRES_URL_MESSAGE,
	probeLiveAppTarget,
} from "@plannotator/pi-extension/generated/live-probe.ts";
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
	isConvertedSource,
	urlToMarkdown,
} from "@plannotator/pi-extension/generated/url-to-markdown.ts";
import {
	getStartupErrorMessage,
	startLastMessageAnnotationSession,
	startMarkdownAnnotationSession,
} from "@plannotator/pi-extension/plannotator-events.ts";
import { isRemoteSession } from "@plannotator/pi-extension/server/network.ts";
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
	}
	| {
		kind: "url";
		url: string;
		markdown: string;
		sourceConverted: boolean;
		live: boolean;
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

type ActiveRuntime = {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	token: symbol;
	sessionId: string;
};

type PendingAnnotation = {
	origin: AnnotationOrigin;
	request: AnnotationRequest;
	session: AnnotationSession;
	stopping: boolean;
};

type ReloadTransition = {
	sessionId: string;
	promise: Promise<void>;
	resolve: () => void;
};

type AnnotationRuntimeState = {
	activeRuntime?: ActiveRuntime;
	pending: Set<PendingAnnotation>;
	reload?: ReloadTransition;
};

const ANNOTATION_RUNTIME_STATE = Symbol.for("@siddr/pi-annotate/runtime-state");

function getRuntimeState(): AnnotationRuntimeState {
	const globalState = globalThis as typeof globalThis & {
		[ANNOTATION_RUNTIME_STATE]?: AnnotationRuntimeState;
	};
	globalState[ANNOTATION_RUNTIME_STATE] ??= { pending: new Set() };
	return globalState[ANNOTATION_RUNTIME_STATE];
}

function setActiveRuntime(pi: ExtensionAPI, ctx: ExtensionContext, token: symbol): void {
	const state = getRuntimeState();
	const sessionId = ctx.sessionManager.getSessionId();
	state.activeRuntime = { pi, ctx, token, sessionId };
	if (state.reload?.sessionId === sessionId) {
		state.reload.resolve();
		state.reload = undefined;
	}
}

function beginReload(sessionId: string, token: symbol): void {
	const state = getRuntimeState();
	if (state.activeRuntime?.token !== token) return;
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	state.activeRuntime = undefined;
	state.reload = { sessionId, promise, resolve };
}

async function getActiveRuntime(origin: AnnotationOrigin): Promise<ActiveRuntime | undefined> {
	const state = getRuntimeState();
	if (state.activeRuntime?.sessionId === origin.sessionId) return state.activeRuntime;
	if (state.reload?.sessionId === origin.sessionId) {
		await state.reload.promise;
		return state.activeRuntime?.sessionId === origin.sessionId ? state.activeRuntime : undefined;
	}
	return undefined;
}

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
				: request.kind === "url"
					? await startMarkdownAnnotationSession(
						plannotatorCtx,
						request.url,
						request.markdown,
						request.live ? "annotate-app" : "annotate",
						undefined,
						request.url,
						request.sourceConverted,
						undefined,
						undefined,
						false,
						undefined,
						undefined,
						request.live ? request.url : undefined,
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

type ResolveAnnotationRequestOptions = {
	probeLiveAppTarget?: typeof probeLiveAppTarget;
	urlToMarkdown?: typeof urlToMarkdown;
	isRemoteSession?: typeof isRemoteSession;
};

export async function resolveAnnotationRequest(
	ctx: ExtensionContext,
	args: string,
	options: ResolveAnnotationRequestOptions = {},
): Promise<AnnotationRequest | undefined> {
	if (!args.trim()) return undefined;
	const parsedArgs = parseAnnotateArgs(args, { liveFlags: true });
	const { app, static: forceStatic, noJina } = parsedArgs;
	if (app && forceStatic) {
		throw new Error("--app and --static are mutually exclusive");
	}
	if (!parsedArgs.filePath) {
		throw new Error(app ? LIVE_APP_REQUIRES_URL_MESSAGE : "A URL target is required when using annotation flags.");
	}

	const target = parsedArgs.filePath;
	const isUrl = /^https?:\/\//i.test(target);
	if (!isUrl && app) {
		throw new Error(LIVE_APP_REQUIRES_URL_MESSAGE);
	}
	if (isUrl) {
		const { parsed, loopback } = classifyLiveAppCandidate(target);
		if (app && !loopback) {
			throw new Error(LIVE_APP_REQUIRES_LOOPBACK_MESSAGE);
		}
		if (app && parsed?.protocol === "https:") {
			throw new Error(LIVE_APP_REQUIRES_HTTP_MESSAGE);
		}

		if (loopback && parsed?.protocol === "http:" && !forceStatic) {
			const probe = await (options.probeLiveAppTarget ?? probeLiveAppTarget)(target, parsed);
			if (probe.liveEligible) {
				if ((options.isRemoteSession ?? isRemoteSession)()) {
					throw new Error(LIVE_APP_REMOTE_MESSAGE);
				}
				notify(ctx, `Live app: ${target}`);
				return { kind: "url", url: target, markdown: "", sourceConverted: false, live: true };
			}
			if (app) {
				throw new Error(buildForceAppFailureMessage(target, probe));
			}
			if (probe.probeError !== null) {
				notify(ctx, buildLiveProbeFallbackNotice(target, probe.probeError));
			}
		}

		const useJina = resolveUseJina(noJina, loadConfig());
		notify(ctx, `Fetching: ${target}${useJina ? " (via Jina Reader)" : " (via fetch+Turndown)"}...`);
		const result = await (options.urlToMarkdown ?? urlToMarkdown)(target, { useJina });
		return {
			kind: "url",
			url: target,
			markdown: result.markdown,
			sourceConverted: isConvertedSource(result.source),
			live: false,
		};
	}

	const targetPath = resolvePathInput(parsedArgs.rawFilePath, ctx.cwd);
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
	const isUrl = request.kind === "url";
	const filePath = isFolder ? request.folderPath : isUrl ? request.url : request.filePath;
	return {
		...decision,
		feedback: getAnnotateFileFeedbackPrompt("pi", loadConfig(), {
			fileHeader: isFolder ? "Folder" : isUrl ? "URL" : "File",
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
		const runtimeToken = Symbol("pi-annotate-runtime");

		const handleSession = async (pending: PendingAnnotation) => {
			try {
				const decision = await pending.session.waitForDecision();
				const runtime = await getActiveRuntime(pending.origin);
				if (!runtime) return;
				if (!isCurrentOrigin(runtime.ctx, pending.origin)) {
					notify(runtime.ctx, "Annotation feedback was not sent because the conversation moved.", "warning");
					return;
				}
				await handlePlannotatorDecision(
					runtime.pi,
					runtime.ctx,
					prepareDecision(pending.request, decision),
					{ notifications: decisionNotifications(pending.request) },
				);
			} catch (error) {
				if (!pending.stopping) {
					const runtime = await getActiveRuntime(pending.origin);
					if (runtime && isCurrentOrigin(runtime.ctx, pending.origin)) {
						const message = error instanceof Error ? error.message : "Annotation session failed.";
						notify(runtime.ctx, message, "error");
					}
				}
			} finally {
				getRuntimeState().pending.delete(pending);
			}
		};

		registerPlannotatorFeedbackRenderer(pi);
		pi.on("session_start", (_event, ctx) => {
			setActiveRuntime(pi, ctx, runtimeToken);
		});
		pi.registerCommand("annotate", {
			description: "Annotate the last assistant message, a path, or a URL in Plannotator",
			handler: async (args, ctx) => {
				if (!isTuiMode(ctx)) {
					notify(ctx, "Annotation is only available in TUI mode.", "error");
					return;
				}

				await ctx.waitForIdle();
				setActiveRuntime(pi, ctx, runtimeToken);
				let request: AnnotationRequest;
				try {
					const pathRequest = await resolveAnnotationRequest(ctx, args);
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
					const pending: PendingAnnotation = { origin, request, session, stopping: false };
					getRuntimeState().pending.add(pending);
					void handleSession(pending);
				} catch (error) {
					const message = error instanceof Error ? error.message : "Failed to open annotation.";
					notify(ctx, message, "error");
				}
			},
		});

		pi.on("session_shutdown", (event, ctx) => {
			const sessionId = ctx.sessionManager.getSessionId();
			if (event.reason === "reload") {
				beginReload(sessionId, runtimeToken);
				return;
			}
			const state = getRuntimeState();
			if (state.activeRuntime?.token === runtimeToken) state.activeRuntime = undefined;
			for (const pending of [...state.pending]) {
				if (pending.origin.sessionId !== sessionId) continue;
				pending.stopping = true;
				pending.session.stop();
				state.pending.delete(pending);
			}
		});
	};
}

export default createAnnotateExtension();
