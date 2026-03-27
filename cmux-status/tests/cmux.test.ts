import { createServer } from "node:net";
import { describe, expect, test } from "bun:test";
import { buildClearStatusSocketCommand, buildSetStatusSocketCommand, createCmuxTransport, getCmuxSocketPath, isSuccessfulCmuxSocketCommandResponse, parseCmuxSocketAddress, sendCmuxSocketLine } from "../cmux";
import type { CmuxStatusPresentation } from "../utils";

function createExecSpy() {
	const calls: Array<{
		command: string;
		args: string[];
		options: { cwd?: string; timeout?: number };
	}> = [];
	const exec = async (command: string, args: string[], options: { cwd?: string; timeout?: number }) => {
		calls.push({ command, args, options });
		return { stdout: "", stderr: "", code: 0, killed: false };
	};
	return { exec, calls };
}

const READY_PRESENTATION: CmuxStatusPresentation = {
	status: "Ready",
	text: "π build: Ready",
	icon: "checkmark",
	color: null,
};

describe("getCmuxSocketPath", () => {
	test("uses the default socket path when the env var is missing", () => {
		expect(getCmuxSocketPath({})).toBe("/tmp/cmux.sock");
	});

	test("uses a trimmed CMUX_SOCKET_PATH override", () => {
		expect(getCmuxSocketPath({ CMUX_SOCKET_PATH: "  /tmp/custom.sock  " })).toBe("/tmp/custom.sock");
	});
});

describe("parseCmuxSocketAddress", () => {
	test("parses unix socket paths", () => {
		expect(parseCmuxSocketAddress("/tmp/cmux.sock")).toEqual({ path: "/tmp/cmux.sock" });
	});

	test("parses tcp relay addresses", () => {
		expect(parseCmuxSocketAddress("127.0.0.1:12345")).toEqual({ host: "127.0.0.1", port: 12345 });
	});
});

describe("socket command helpers", () => {
	test("formats set-status socket commands", () => {
		expect(buildSetStatusSocketCommand("workspace:1", "pi-cmux-status:surface:1", READY_PRESENTATION)).toBe('set_status pi-cmux-status:surface:1 "π build: Ready" --icon=checkmark --tab=workspace:1');
	});

	test("formats clear-status socket commands", () => {
		expect(buildClearStatusSocketCommand("workspace:1", "pi-cmux-status:surface:1")).toBe("clear_status pi-cmux-status:surface:1 --tab=workspace:1");
	});

	test("detects socket command failures from text and json responses", () => {
		expect(isSuccessfulCmuxSocketCommandResponse("")).toBeTrue();
		expect(isSuccessfulCmuxSocketCommandResponse('{"ok":true}')).toBeTrue();
		expect(isSuccessfulCmuxSocketCommandResponse('{"ok":false}')).toBeFalse();
		expect(isSuccessfulCmuxSocketCommandResponse("error unsupported command")).toBeFalse();
	});
});

describe("sendCmuxSocketLine", () => {
	test("supports tcp relay addresses", async () => {
		const server = createServer((socket) => {
			socket.setEncoding("utf8");
			socket.once("data", (data) => {
				expect(data).toBe('{"id":"ping"}\n');
				socket.write('{"id":"ping","ok":true}\n');
				socket.end();
			});
		});

		await new Promise<void>((resolve, reject) => {
			server.listen(0, "127.0.0.1", () => resolve());
			server.once("error", reject);
		});

		try {
			const address = server.address();
			if (!address || typeof address === "string") {
				throw new Error("Expected a tcp server address");
			}

			await expect(sendCmuxSocketLine(`127.0.0.1:${address.port}`, '{"id":"ping"}', 1500)).resolves.toBe('{"id":"ping","ok":true}');
		} finally {
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
	});
});

describe("createCmuxTransport", () => {
	test("uses the socket transport for status updates when the socket succeeds", async () => {
		const { exec, calls } = createExecSpy();
		const socketCalls: Array<{
			socketPath: string;
			line: string;
			timeoutMs: number;
		}> = [];
		const transport = createCmuxTransport({
			exec,
			env: { CMUX_SOCKET_PATH: "/tmp/test.sock" },
			sendSocketLine: async (socketPath, line, timeoutMs) => {
				socketCalls.push({ socketPath, line, timeoutMs });
				return "";
			},
		});

		const result = await transport.setStatus("/tmp/project", "workspace:1", "pi-cmux-status:surface:1", READY_PRESENTATION);

		expect(result).toEqual({ ok: true, transport: "socket" });
		expect(socketCalls).toEqual([
			{
				socketPath: "/tmp/test.sock",
				line: 'set_status pi-cmux-status:surface:1 "π build: Ready" --icon=checkmark --tab=workspace:1',
				timeoutMs: 1500,
			},
		]);
		expect(calls).toEqual([]);
	});

	test("falls back to the cli and stays there after a socket failure", async () => {
		const { exec, calls } = createExecSpy();
		let socketCallCount = 0;
		const transport = createCmuxTransport({
			exec,
			sendSocketLine: async () => {
				socketCallCount += 1;
				throw new Error("socket unavailable");
			},
		});

		const first = await transport.setStatus("/tmp/project", "workspace:1", "pi-cmux-status:surface:1", READY_PRESENTATION);
		const second = await transport.clearStatus("/tmp/project", "workspace:1", "pi-cmux-status:surface:1");

		expect(first).toEqual({ ok: true, transport: "cli" });
		expect(second).toEqual({ ok: true, transport: "cli" });
		expect(socketCallCount).toBe(1);
		expect(calls).toEqual([
			{
				command: "cmux",
				args: ["set-status", "pi-cmux-status:surface:1", "π build: Ready", "--icon", "checkmark", "--workspace", "workspace:1"],
				options: { cwd: "/tmp/project", timeout: 1500 },
			},
			{
				command: "cmux",
				args: ["clear-status", "pi-cmux-status:surface:1", "--workspace", "workspace:1"],
				options: { cwd: "/tmp/project", timeout: 1500 },
			},
		]);
	});

	test("sends json-rpc notifications over the socket", async () => {
		const { exec, calls } = createExecSpy();
		const socketLines: string[] = [];
		const transport = createCmuxTransport({
			exec,
			env: { CMUX_SURFACE_ID: "surface:1" },
			sendSocketLine: async (_socketPath, line) => {
				socketLines.push(line);
				return '{"id":"pi-cmux-status:notify:1","ok":true,"result":{}}';
			},
		});

		const result = await transport.notify("/tmp/project", "workspace:1", "π build: Waiting", "Waiting for user input.");

		expect(result).toEqual({ ok: true, transport: "socket" });
		expect(JSON.parse(socketLines[0] ?? "{}")).toEqual({
			id: "pi-cmux-status:notify:1",
			method: "notification.create",
			params: {
				title: "π build: Waiting",
				body: "Waiting for user input.",
				workspace_id: "workspace:1",
				surface_id: "surface:1",
			},
		});
		expect(calls).toEqual([]);
	});

	test("falls back to cli notifications when the socket response is unsuccessful", async () => {
		const { exec, calls } = createExecSpy();
		let socketCallCount = 0;
		const transport = createCmuxTransport({
			exec,
			env: { CMUX_SURFACE_ID: "surface:1" },
			sendSocketLine: async () => {
				socketCallCount += 1;
				return '{"id":"pi-cmux-status:notify:1","ok":false,"error":{"message":"denied"}}';
			},
		});

		const first = await transport.notify("/tmp/project", "workspace:1", "π build: Waiting", "Waiting for user input.");
		const second = await transport.notify("/tmp/project", "workspace:1", "π build: Waiting", "Waiting for user input.");

		expect(first).toEqual({ ok: true, transport: "cli" });
		expect(second).toEqual({ ok: true, transport: "cli" });
		expect(socketCallCount).toBe(1);
		expect(calls).toEqual([
			{
				command: "cmux",
				args: ["notify", "--title", "π build: Waiting", "--body", "Waiting for user input.", "--workspace", "workspace:1", "--surface", "surface:1"],
				options: { cwd: "/tmp/project", timeout: 1500 },
			},
			{
				command: "cmux",
				args: ["notify", "--title", "π build: Waiting", "--body", "Waiting for user input.", "--workspace", "workspace:1", "--surface", "surface:1"],
				options: { cwd: "/tmp/project", timeout: 1500 },
			},
		]);
	});
});
