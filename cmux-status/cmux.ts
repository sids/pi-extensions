import { createConnection } from "node:net";
import type { CmuxStatusPresentation } from "./utils";

const CMUX_COMMAND_TIMEOUT_MS = 1500;
const DEFAULT_CMUX_SOCKET_PATH = "/tmp/cmux.sock";

type ExecResult = {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
};

type ExecOptions = {
	cwd?: string;
	timeout?: number;
};

export type CmuxExec = (command: string, args: string[], options: ExecOptions) => Promise<ExecResult>;

export type CmuxTransportResult = {
	ok: boolean;
	transport: "socket" | "cli";
};

export type CmuxTransport = {
	setStatus: (cwd: string, workspaceId: string, statusKey: string, presentation: CmuxStatusPresentation) => Promise<CmuxTransportResult>;
	clearStatus: (cwd: string, workspaceId: string, statusKey: string) => Promise<CmuxTransportResult>;
	notify: (cwd: string, workspaceId: string, title: string, body: string, subtitle?: string) => Promise<CmuxTransportResult>;
};

export type CmuxSocketLineRequester = (socketAddress: string, line: string, timeoutMs: number) => Promise<string>;

export type CreateCmuxTransportOptions = {
	exec: CmuxExec;
	env?: Record<string, string | undefined>;
	sendSocketLine?: CmuxSocketLineRequester;
};

type SocketRequest =
	| {
			kind: "command";
			line: string;
	  }
	| {
			kind: "json";
			payload: Record<string, unknown>;
	  };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readNonEmptyString(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed ? trimmed : null;
}

export function getCmuxSocketPath(env: Record<string, string | undefined> = process.env): string {
	return readNonEmptyString(env.CMUX_SOCKET_PATH) ?? DEFAULT_CMUX_SOCKET_PATH;
}

export function getCmuxSurfaceId(env: Record<string, string | undefined> = process.env): string | null {
	return readNonEmptyString(env.CMUX_SURFACE_ID);
}

export function parseCmuxSocketAddress(address: string): { path: string } | { host: string; port: number } {
	const trimmedAddress = address.trim();
	const ipv6Match = trimmedAddress.match(/^\[([^\]]+)\]:(\d+)$/);
	if (ipv6Match) {
		return { host: ipv6Match[1] ?? "", port: Number(ipv6Match[2]) };
	}

	const hostPortMatch = trimmedAddress.match(/^([^/:]+):(\d+)$/);
	if (hostPortMatch) {
		return { host: hostPortMatch[1] ?? "", port: Number(hostPortMatch[2]) };
	}

	return { path: trimmedAddress };
}

export function quoteCmuxSocketArg(value: string): string {
	if (/^[A-Za-z0-9:._/#-]+$/.test(value)) {
		return value;
	}
	return JSON.stringify(value);
}

export function buildSetStatusSocketCommand(workspaceId: string, statusKey: string, presentation: CmuxStatusPresentation): string {
	const args = ["set_status", quoteCmuxSocketArg(statusKey), quoteCmuxSocketArg(presentation.text)];
	if (presentation.icon) {
		args.push(`--icon=${quoteCmuxSocketArg(presentation.icon)}`);
	}
	if (presentation.color) {
		args.push(`--color=${quoteCmuxSocketArg(presentation.color)}`);
	}
	args.push(`--tab=${quoteCmuxSocketArg(workspaceId)}`);
	return args.join(" ");
}

export function buildClearStatusSocketCommand(workspaceId: string, statusKey: string): string {
	return `clear_status ${quoteCmuxSocketArg(statusKey)} --tab=${quoteCmuxSocketArg(workspaceId)}`;
}

export function isSuccessfulCmuxSocketCommandResponse(raw: string): boolean {
	const trimmed = raw.trim();
	if (!trimmed) {
		return true;
	}

	try {
		const parsed = JSON.parse(trimmed);
		if (isRecord(parsed) && typeof parsed.ok === "boolean") {
			return parsed.ok;
		}
	} catch {
		// Fall through to text-based detection.
	}

	return !/^(error|err(or)?|unknown command|unsupported)\b/i.test(trimmed);
}

export async function sendCmuxSocketLine(socketAddress: string, line: string, timeoutMs: number): Promise<string> {
	return await new Promise((resolve, reject) => {
		const endpoint = parseCmuxSocketAddress(socketAddress);
		const socket = "path" in endpoint ? createConnection(endpoint.path) : createConnection(endpoint.port, endpoint.host);
		let settled = false;
		let response = "";

		const finish = (callback: () => void) => {
			if (settled) {
				return;
			}
			settled = true;
			socket.removeAllListeners();
			socket.destroy();
			callback();
		};

		socket.setEncoding("utf8");
		socket.setTimeout(timeoutMs, () => {
			finish(() => reject(new Error(`Timed out waiting for cmux socket response after ${timeoutMs}ms`)));
		});
		socket.on("connect", () => {
			socket.write(line.endsWith("\n") ? line : `${line}\n`);
		});
		socket.on("data", (chunk) => {
			response += chunk;
			const newlineIndex = response.indexOf("\n");
			if (newlineIndex >= 0) {
				const lineResponse = response.slice(0, newlineIndex).trim();
				finish(() => resolve(lineResponse));
			}
		});
		socket.on("end", () => {
			finish(() => resolve(response.trim()));
		});
		socket.on("close", () => {
			finish(() => resolve(response.trim()));
		});
		socket.on("error", (error) => {
			finish(() => reject(error));
		});
	});
}

function isSuccessfulJsonSocketResponse(raw: string): boolean {
	const trimmed = raw.trim();
	if (!trimmed) {
		return false;
	}

	try {
		const parsed = JSON.parse(trimmed);
		return isRecord(parsed) && parsed.ok === true;
	} catch {
		return false;
	}
}

class DefaultCmuxTransport implements CmuxTransport {
	private readonly exec: CmuxExec;
	private readonly env: Record<string, string | undefined>;
	private readonly sendSocketLine: CmuxSocketLineRequester;
	private prefersCli = false;
	private nextRequestId = 0;

	constructor(options: CreateCmuxTransportOptions) {
		this.exec = options.exec;
		this.env = options.env ?? process.env;
		this.sendSocketLine = options.sendSocketLine ?? sendCmuxSocketLine;
	}

	async setStatus(cwd: string, workspaceId: string, statusKey: string, presentation: CmuxStatusPresentation): Promise<CmuxTransportResult> {
		return await this.runWithFallback(cwd, {
			socket: {
				kind: "command",
				line: buildSetStatusSocketCommand(workspaceId, statusKey, presentation),
			},
			cliArgs: this.buildSetStatusCliArgs(workspaceId, statusKey, presentation),
		});
	}

	async clearStatus(cwd: string, workspaceId: string, statusKey: string): Promise<CmuxTransportResult> {
		return await this.runWithFallback(cwd, {
			socket: {
				kind: "command",
				line: buildClearStatusSocketCommand(workspaceId, statusKey),
			},
			cliArgs: ["clear-status", statusKey, "--workspace", workspaceId],
		});
	}

	async notify(cwd: string, workspaceId: string, title: string, body: string, subtitle?: string): Promise<CmuxTransportResult> {
		const params: Record<string, unknown> = {
			title,
			body,
			workspace_id: workspaceId,
		};
		const surfaceId = getCmuxSurfaceId(this.env);
		if (surfaceId) {
			params.surface_id = surfaceId;
		}
		if (subtitle) {
			params.subtitle = subtitle;
		}

		const cliArgs = ["notify", "--title", title];
		if (subtitle) {
			cliArgs.push("--subtitle", subtitle);
		}
		cliArgs.push("--body", body, "--workspace", workspaceId);
		if (surfaceId) {
			cliArgs.push("--surface", surfaceId);
		}

		return await this.runWithFallback(cwd, {
			socket: {
				kind: "json",
				payload: {
					id: this.createRequestId("notify"),
					method: "notification.create",
					params,
				},
			},
			cliArgs,
		});
	}

	private buildSetStatusCliArgs(workspaceId: string, statusKey: string, presentation: CmuxStatusPresentation): string[] {
		const args = ["set-status", statusKey, presentation.text];
		if (presentation.icon) {
			args.push("--icon", presentation.icon);
		}
		if (presentation.color) {
			args.push("--color", presentation.color);
		}
		args.push("--workspace", workspaceId);
		return args;
	}

	private createRequestId(prefix: string): string {
		this.nextRequestId += 1;
		return `pi-cmux-status:${prefix}:${this.nextRequestId}`;
	}

	private async runWithFallback(cwd: string, options: { socket: SocketRequest; cliArgs: string[] }): Promise<CmuxTransportResult> {
		if (!this.prefersCli) {
			const socketResult = await this.trySocket(options.socket);
			if (socketResult.ok) {
				return socketResult;
			}
			this.prefersCli = true;
		}

		return await this.runCli(cwd, options.cliArgs);
	}

	private async trySocket(request: SocketRequest): Promise<CmuxTransportResult> {
		try {
			const line = request.kind === "command" ? request.line : JSON.stringify(request.payload);
			const response = await this.sendSocketLine(getCmuxSocketPath(this.env), line, CMUX_COMMAND_TIMEOUT_MS);
			const ok = request.kind === "command" ? isSuccessfulCmuxSocketCommandResponse(response) : isSuccessfulJsonSocketResponse(response);
			if (!ok) {
				return { ok: false, transport: "socket" };
			}
			return { ok: true, transport: "socket" };
		} catch {
			return { ok: false, transport: "socket" };
		}
	}

	private async runCli(cwd: string, args: string[]): Promise<CmuxTransportResult> {
		try {
			const result = await this.exec("cmux", args, {
				cwd,
				timeout: CMUX_COMMAND_TIMEOUT_MS,
			});
			return { ok: result.code === 0, transport: "cli" };
		} catch {
			return { ok: false, transport: "cli" };
		}
	}
}

export function createCmuxTransport(options: CreateCmuxTransportOptions): CmuxTransport {
	return new DefaultCmuxTransport(options);
}
