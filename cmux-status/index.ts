import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createCmuxTransport, type CmuxTransport, type CreateCmuxTransportOptions } from "./cmux";
import { areCmuxStatusPresentationsEqual, formatCmuxStatusKey, formatCmuxStatusText, getCmuxStatusOwnerId, getCmuxStatusPresentation, getCmuxWorkspaceId, type CmuxStatusLabel, type CmuxStatusPresentation } from "./utils";

const USER_INPUT_WAIT_EVENT = "pi:waiting-for-user-input";
const WORKING_ANIMATION_INTERVAL_MS = 400;

type CmuxSidebarState = {
	workspaceId: string | null;
	available: boolean;
	lastWrittenStatusKey: string | null;
	lastWrittenStatusPresentation: CmuxStatusPresentation | null;
};

type WaitingForUserInputEvent = {
	source: string;
	id: string;
	waiting: boolean;
};

function createCmuxSidebarState(): CmuxSidebarState {
	return {
		workspaceId: null,
		available: true,
		lastWrittenStatusKey: null,
		lastWrittenStatusPresentation: null,
	};
}

function parseWaitingForUserInputEvent(data: unknown): WaitingForUserInputEvent | null {
	if (!data || typeof data !== "object") {
		return null;
	}

	const source = "source" in data && typeof data.source === "string" ? data.source.trim() : "";
	const id = "id" in data && typeof data.id === "string" ? data.id.trim() : "";
	const waiting = "waiting" in data && typeof data.waiting === "boolean" ? data.waiting : null;
	if (!source || !id || waiting === null) {
		return null;
	}

	return { source, id, waiting };
}

export function createCmuxStatusExtension(createTransport: (options: CreateCmuxTransportOptions) => CmuxTransport = createCmuxTransport) {
	return function (pi: ExtensionAPI) {
		const cmuxTransport = createTransport({
			exec: pi.exec.bind(pi),
			env: process.env,
		});
		let enabled = true;
		let currentCtx: ExtensionContext | null = null;
		let agentRunning = false;
		let hasError = false;
		let activeToolCallIds = new Set<string>();
		let waitingForUserInputIds = new Set<string>();
		let waitingNotificationSent = false;
		let workingAnimationFrame = 0;
		let workingAnimationTimer: ReturnType<typeof setInterval> | null = null;
		let queuedUpdate: { ctx: ExtensionContext; animationFrame: number } | null = null;
		let updatePromise: Promise<void> | null = null;
		let cmuxSidebarState = createCmuxSidebarState();

		const rememberCtx = (ctx: ExtensionContext) => {
			currentCtx = ctx;
		};

		const forgetLastWrittenStatus = () => {
			cmuxSidebarState.lastWrittenStatusKey = null;
			cmuxSidebarState.lastWrittenStatusPresentation = null;
		};

		const stopWorkingAnimation = () => {
			if (workingAnimationTimer !== null) {
				clearInterval(workingAnimationTimer);
				workingAnimationTimer = null;
			}
			workingAnimationFrame = 0;
		};

		const resetRuntimeState = () => {
			agentRunning = false;
			hasError = false;
			activeToolCallIds = new Set<string>();
			waitingForUserInputIds = new Set<string>();
			waitingNotificationSent = false;
			queuedUpdate = null;
			stopWorkingAnimation();
		};

		const resetCmuxSidebarState = () => {
			cmuxSidebarState = createCmuxSidebarState();
		};

		const resolveStatus = (): CmuxStatusLabel => {
			if (waitingForUserInputIds.size > 0) {
				return "Waiting";
			}
			if (hasError) {
				return "Error";
			}
			if (agentRunning || activeToolCallIds.size > 0) {
				return "Working";
			}
			return "Ready";
		};

		const getCurrentStatusKey = () => {
			const ownerId = getCmuxStatusOwnerId();
			return ownerId ? formatCmuxStatusKey(ownerId) : null;
		};
		const buildStatusPresentation = (status: CmuxStatusLabel, animationFrame = workingAnimationFrame) => getCmuxStatusPresentation(pi.getSessionName(), status, animationFrame);

		const getActiveWorkspaceId = () => {
			const workspaceId = getCmuxWorkspaceId();
			if (!workspaceId || !getCmuxStatusOwnerId() || !cmuxSidebarState.available) {
				return null;
			}
			if (cmuxSidebarState.workspaceId !== workspaceId) {
				forgetLastWrittenStatus();
				cmuxSidebarState.workspaceId = workspaceId;
			}
			return workspaceId;
		};

		const releaseLastWrittenStatus = async (cwd: string) => {
			const workspaceId = getActiveWorkspaceId();
			const { lastWrittenStatusKey } = cmuxSidebarState;
			if (!workspaceId || !lastWrittenStatusKey) {
				forgetLastWrittenStatus();
				return;
			}

			const result = await cmuxTransport.clearStatus(cwd, workspaceId, lastWrittenStatusKey);
			if (!result.ok) {
				cmuxSidebarState.available = false;
				return;
			}
			forgetLastWrittenStatus();
		};

		const syncCmuxStatus = async (cwd: string, status: CmuxStatusLabel | null, animationFrame = workingAnimationFrame) => {
			const workspaceId = getActiveWorkspaceId();
			const statusKey = getCurrentStatusKey();
			if (!workspaceId || !statusKey) {
				return;
			}

			if (cmuxSidebarState.lastWrittenStatusKey && cmuxSidebarState.lastWrittenStatusKey !== statusKey) {
				await releaseLastWrittenStatus(cwd);
				if (!cmuxSidebarState.available) {
					return;
				}
			}

			const nextPresentation = status ? buildStatusPresentation(status, animationFrame) : null;
			const lastWrittenPresentationForKey = cmuxSidebarState.lastWrittenStatusKey === statusKey ? cmuxSidebarState.lastWrittenStatusPresentation : null;
			if (areCmuxStatusPresentationsEqual(lastWrittenPresentationForKey, nextPresentation)) {
				return;
			}

			if (nextPresentation === null) {
				if (cmuxSidebarState.lastWrittenStatusKey !== statusKey) {
					return;
				}
				const result = await cmuxTransport.clearStatus(cwd, workspaceId, statusKey);
				if (!result.ok) {
					cmuxSidebarState.available = false;
					return;
				}
				forgetLastWrittenStatus();
				return;
			}

			const result = await cmuxTransport.setStatus(cwd, workspaceId, statusKey, nextPresentation);
			if (!result.ok) {
				cmuxSidebarState.available = false;
				return;
			}

			cmuxSidebarState.lastWrittenStatusKey = statusKey;
			cmuxSidebarState.lastWrittenStatusPresentation = nextPresentation;
		};

		const sendWaitingNotification = async (ctx: ExtensionContext) => {
			const workspaceId = getActiveWorkspaceId();
			if (!workspaceId) {
				return false;
			}

			const result = await cmuxTransport.notify(ctx.cwd, workspaceId, formatCmuxStatusText(pi.getSessionName(), "Waiting"), "Waiting for user input.");
			return result.ok;
		};

		const ensureWorkingAnimation = () => {
			if (workingAnimationTimer !== null) {
				return;
			}
			workingAnimationTimer = setInterval(() => {
				if (!enabled || !currentCtx) {
					return;
				}
				if (resolveStatus() !== "Working") {
					stopWorkingAnimation();
					return;
				}
				workingAnimationFrame += 1;
				void updateCmuxStatus(currentCtx, workingAnimationFrame);
			}, WORKING_ANIMATION_INTERVAL_MS);
		};

		const cancelQueuedCmuxUpdates = () => {
			queuedUpdate = null;
		};

		const waitForInFlightCmuxUpdate = async () => {
			if (updatePromise) {
				await updatePromise;
			}
		};

		const performCmuxStatusUpdate = async (ctx: ExtensionContext, animationFrame = workingAnimationFrame) => {
			const resolvedStatus = enabled ? resolveStatus() : null;
			if (resolvedStatus === "Working") {
				ensureWorkingAnimation();
			} else {
				stopWorkingAnimation();
			}

			await syncCmuxStatus(ctx.cwd, resolvedStatus, animationFrame);

			if (resolvedStatus !== "Waiting") {
				waitingNotificationSent = false;
				return;
			}
			if (waitingNotificationSent || !enabled) {
				return;
			}
			if (await sendWaitingNotification(ctx)) {
				waitingNotificationSent = true;
			}
		};

		const updateCmuxStatus = async (ctx: ExtensionContext, animationFrame = workingAnimationFrame) => {
			queuedUpdate = { ctx, animationFrame };
			if (updatePromise) {
				await updatePromise;
				return;
			}

			updatePromise = (async () => {
				while (queuedUpdate) {
					const nextUpdate = queuedUpdate;
					queuedUpdate = null;
					await performCmuxStatusUpdate(nextUpdate.ctx, nextUpdate.animationFrame);
				}
			})();

			try {
				await updatePromise;
			} finally {
				updatePromise = null;
			}
		};

		pi.events.on(USER_INPUT_WAIT_EVENT, (data) => {
			const parsed = parseWaitingForUserInputEvent(data);
			if (!parsed) {
				return;
			}
			const key = `${parsed.source}:${parsed.id}`;
			if (parsed.waiting) {
				waitingForUserInputIds.add(key);
			} else {
				waitingForUserInputIds.delete(key);
			}
			if (currentCtx) {
				void updateCmuxStatus(currentCtx);
			}
		});

		pi.on("session_start", async (_event, ctx) => {
			rememberCtx(ctx);
			resetRuntimeState();
			await updateCmuxStatus(ctx);
		});

		pi.on("input", async (_event, ctx) => {
			rememberCtx(ctx);
			if (!hasError) {
				return;
			}
			hasError = false;
			await updateCmuxStatus(ctx);
		});

		pi.on("agent_start", async (_event, ctx) => {
			rememberCtx(ctx);
			hasError = false;
			agentRunning = true;
			await updateCmuxStatus(ctx);
		});

		pi.on("agent_end", async (_event, ctx) => {
			rememberCtx(ctx);
			agentRunning = false;
			activeToolCallIds = new Set<string>();
			await updateCmuxStatus(ctx);
		});

		pi.on("tool_execution_start", async (event, ctx) => {
			rememberCtx(ctx);
			hasError = false;
			activeToolCallIds.add(event.toolCallId);
			await updateCmuxStatus(ctx);
		});

		pi.on("tool_execution_end", async (event, ctx) => {
			rememberCtx(ctx);
			activeToolCallIds.delete(event.toolCallId);
			if (event.isError) {
				hasError = true;
			}
			await updateCmuxStatus(ctx);
		});

		pi.on("session_shutdown", async (_event, ctx) => {
			rememberCtx(ctx);
			resetRuntimeState();
			cancelQueuedCmuxUpdates();
			await waitForInFlightCmuxUpdate();
			await releaseLastWrittenStatus(ctx.cwd);
			resetCmuxSidebarState();
			currentCtx = null;
		});

		pi.registerCommand("custom-cmux-status", {
			description: "Toggle cmux status updates",
			handler: async (_args, ctx) => {
				rememberCtx(ctx);
				enabled = !enabled;
				if (enabled) {
					await updateCmuxStatus(ctx);
					if (ctx.hasUI) {
						ctx.ui.notify("cmux status enabled", "info");
					}
					return;
				}

				waitingNotificationSent = false;
				stopWorkingAnimation();
				cancelQueuedCmuxUpdates();
				await waitForInFlightCmuxUpdate();
				await releaseLastWrittenStatus(ctx.cwd);
				if (ctx.hasUI) {
					ctx.ui.notify("cmux status disabled", "info");
				}
			},
		});
	};
}

export default createCmuxStatusExtension();
