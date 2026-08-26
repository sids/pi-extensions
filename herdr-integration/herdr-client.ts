import net from "node:net";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type HerdrAgentState = "working" | "blocked" | "idle";

export type HerdrRequest = {
	id: string;
	method: string;
	params: Record<string, unknown>;
};

export type HerdrReporter = {
	reportSession(ctx: ExtensionContext, sessionStartSource?: string): Promise<void>;
	reportState(state: HerdrAgentState, message: string | undefined, ctx: ExtensionContext): void;
};

type QueuedState = {
	state: HerdrAgentState;
	message?: string;
	seq: number;
	params: Record<string, unknown>;
};

type DeliverRequest = (request: HerdrRequest) => Promise<void>;

function socketEndpoint(socketPath: string): string {
	return process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;
}

function sendRequestAttempt(
	socketPath: string,
	request: HerdrRequest,
	timeoutMs: number,
): Promise<boolean> {
	return new Promise((resolve) => {
		let done = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const socket = net.createConnection(socketEndpoint(socketPath));
		const finish = (delivered: boolean) => {
			if (done) {
				return;
			}
			done = true;
			if (timeout) {
				clearTimeout(timeout);
			}
			socket.destroy();
			resolve(delivered);
		};

		socket.on("error", () => finish(false));
		socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
		socket.on("data", () => finish(true));
		socket.on("end", () => finish(false));
		timeout = setTimeout(() => finish(false), timeoutMs);
		timeout.unref?.();
	});
}

function createSocketDelivery(socketPath: string): DeliverRequest {
	return async (request) => {
		if (await sendRequestAttempt(socketPath, request, 500)) {
			return;
		}
		await sendRequestAttempt(socketPath, request, 1500);
	};
}

function sessionReference(ctx: ExtensionContext): Record<string, unknown> {
	try {
		const file = ctx.sessionManager.getSessionFile?.();
		if (typeof file === "string" && file.startsWith("/")) {
			return { agent_session_path: file };
		}
	} catch {
		// Fall back to the session id when the session file is unavailable.
	}

	try {
		const id = ctx.sessionManager.getSessionId?.();
		if (typeof id === "string" && id.length > 0) {
			return { agent_session_id: id };
		}
	} catch {
		// Ephemeral sessions do not have a reportable reference.
	}

	return {};
}

export function createHerdrReporter(
	env: Record<string, string | undefined> = process.env,
	deliver?: DeliverRequest,
): HerdrReporter {
	const paneId = env.HERDR_PANE_ID ?? "";
	const source = "herdr:pi";
	const send = deliver ?? createSocketDelivery(env.HERDR_SOCKET_PATH ?? "");
	let reportSeq = Date.now() * 1000;
	let sendInFlight = false;
	let queuedState: QueuedState | undefined;

	const nextReportSeq = () => {
		reportSeq += 1;
		return reportSeq;
	};

	const drainStateQueue = async () => {
		if (sendInFlight) {
			return;
		}
		sendInFlight = true;
		try {
			while (queuedState) {
				const next = queuedState;
				queuedState = undefined;
				await send({
					id: `${source}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
					method: "pane.report_agent",
					params: {
						pane_id: paneId,
						source,
						agent: "pi",
						state: next.state,
						message: next.message,
						seq: next.seq,
						...next.params,
					},
				});
			}
		} finally {
			sendInFlight = false;
			if (queuedState) {
				void drainStateQueue();
			}
		}
	};

	return {
		async reportSession(ctx, sessionStartSource) {
			const reference = sessionReference(ctx);
			if (Object.keys(reference).length === 0) {
				return;
			}
			await send({
				id: `${source}:session:${Date.now()}:${Math.random().toString(36).slice(2)}`,
				method: "pane.report_agent_session",
				params: {
					pane_id: paneId,
					source,
					agent: "pi",
					seq: nextReportSeq(),
					session_start_source: sessionStartSource,
					...reference,
				},
			});
		},
		reportState(state, message, ctx) {
			queuedState = {
				state,
				message,
				seq: nextReportSeq(),
				params: sessionReference(ctx),
			};
			if (!sendInFlight) {
				void drainStateQueue();
			}
		},
	};
}
