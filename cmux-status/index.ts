import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	formatCmuxStatusKey,
	formatCmuxStatusText,
	getCmuxWorkspaceId,
	parseCmuxStatusList,
	shouldOverwriteCmuxStatus,
	type CmuxStatusLabel,
} from "./utils";

const CMUX_COMMAND_TIMEOUT_MS = 1500;
const USER_INPUT_WAIT_EVENT = "pi:waiting-for-user-input";

type CmuxSidebarState = {
	workspaceId: string | null;
	available: boolean;
	lastWrittenStatusKey: string | null;
	lastWrittenStatusText: string | null;
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
		lastWrittenStatusText: null,
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

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let currentCtx: ExtensionContext | null = null;
	let agentRunning = false;
	let hasError = false;
	let activeToolCallIds = new Set<string>();
	let waitingForUserInputIds = new Set<string>();
	let cmuxSidebarState = createCmuxSidebarState();

	const rememberCtx = (ctx: ExtensionContext) => {
		currentCtx = ctx;
	};

	const resetRuntimeState = () => {
		agentRunning = false;
		hasError = false;
		activeToolCallIds = new Set<string>();
		waitingForUserInputIds = new Set<string>();
	};

	const resetCmuxSidebarState = () => {
		cmuxSidebarState = createCmuxSidebarState();
	};

	const forgetLastWrittenStatus = () => {
		cmuxSidebarState.lastWrittenStatusKey = null;
		cmuxSidebarState.lastWrittenStatusText = null;
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

	const getCurrentStatusKey = () => formatCmuxStatusKey(pi.getSessionName());
	const buildStatusText = (status: CmuxStatusLabel) => formatCmuxStatusText(pi.getSessionName(), status);

	const execCmux = async (cwd: string, args: string[]) => {
		try {
			return await pi.exec("cmux", args, { cwd, timeout: CMUX_COMMAND_TIMEOUT_MS });
		} catch {
			return null;
		}
	};

	const refreshCmuxStatus = async (
		cwd: string,
		statusKey: string,
	): Promise<{ workspaceId: string; statusText: string | null } | null> => {
		const workspaceId = getCmuxWorkspaceId();
		if (!workspaceId || !cmuxSidebarState.available) {
			return null;
		}
		if (cmuxSidebarState.workspaceId !== workspaceId) {
			resetCmuxSidebarState();
			cmuxSidebarState.workspaceId = workspaceId;
		}

		const result = await execCmux(cwd, ["list-status", "--json", "--workspace", workspaceId]);
		if (!result || result.code !== 0) {
			cmuxSidebarState.available = false;
			return null;
		}

		const statusText = parseCmuxStatusList(result.stdout).get(statusKey) ?? null;
		return { workspaceId, statusText };
	};

	const releaseLastWrittenStatus = async (cwd: string) => {
		const { lastWrittenStatusKey, lastWrittenStatusText } = cmuxSidebarState;
		if (!lastWrittenStatusKey || !lastWrittenStatusText) {
			forgetLastWrittenStatus();
			return;
		}

		const refreshed = await refreshCmuxStatus(cwd, lastWrittenStatusKey);
		if (refreshed && shouldOverwriteCmuxStatus(refreshed.statusText, lastWrittenStatusText, null)) {
			const result = await execCmux(cwd, ["clear-status", lastWrittenStatusKey, "--workspace", refreshed.workspaceId]);
			if (!result || result.code !== 0) {
				cmuxSidebarState.available = false;
			}
		}
		forgetLastWrittenStatus();
	};

	const syncCmuxStatus = async (cwd: string, status: CmuxStatusLabel | null) => {
		const statusKey = getCurrentStatusKey();
		if (cmuxSidebarState.lastWrittenStatusKey && cmuxSidebarState.lastWrittenStatusKey !== statusKey) {
			await releaseLastWrittenStatus(cwd);
		}

		const refreshed = await refreshCmuxStatus(cwd, statusKey);
		if (!refreshed || !cmuxSidebarState.available) {
			return;
		}

		const nextText = status ? buildStatusText(status) : null;
		const lastWrittenTextForKey = cmuxSidebarState.lastWrittenStatusKey === statusKey ? cmuxSidebarState.lastWrittenStatusText : null;
		if (!shouldOverwriteCmuxStatus(refreshed.statusText, lastWrittenTextForKey, nextText)) {
			return;
		}

		const args = nextText
			? ["set-status", statusKey, nextText, "--workspace", refreshed.workspaceId]
			: ["clear-status", statusKey, "--workspace", refreshed.workspaceId];
		const result = await execCmux(cwd, args);
		if (!result || result.code !== 0) {
			cmuxSidebarState.available = false;
			return;
		}

		if (nextText === null) {
			forgetLastWrittenStatus();
			return;
		}

		cmuxSidebarState.lastWrittenStatusKey = statusKey;
		cmuxSidebarState.lastWrittenStatusText = nextText;
	};

	const updateCmuxStatus = async (ctx: ExtensionContext) => {
		await syncCmuxStatus(ctx.cwd, enabled ? resolveStatus() : null);
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

	pi.on("session_switch", async (_event, ctx) => {
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

			await releaseLastWrittenStatus(ctx.cwd);
			if (ctx.hasUI) {
				ctx.ui.notify("cmux status disabled", "info");
			}
		},
	});
}
