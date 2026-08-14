import { afterEach, describe, expect, test } from "vitest";
import {
	buildTailscaleUrl,
	getTailscaleHost,
	isPlannotatorRemote,
	isPlannotatorTailscaleEnabled,
	preparePlannotatorBrowserSession,
	preparePlannotatorContext,
	resetPlannotatorTailscaleForTests,
	withPlannotatorUrlNotifications,
} from "../plannotator-url";

afterEach(() => {
	resetPlannotatorTailscaleForTests();
});

function createContext() {
	const notifications: Array<{ message: string; level?: string }> = [];
	const ctx = {
		ui: {
			notify(message: string, level?: "info" | "warning" | "error") {
				notifications.push({ message, level });
			},
			theme: {
				fg: (_color: "accent", text: string) => `<accent>${text}</accent>`,
				underline: (text: string) => `<underline>${text}</underline>`,
			},
		},
	};
	return { ctx, notifications };
}

describe("Tailscale host resolution", () => {
	test("recognizes explicit Plannotator remote and Tailscale modes", () => {
		expect(isPlannotatorRemote({ PLANNOTATOR_REMOTE: "1" })).toBe(true);
		expect(isPlannotatorRemote({ PLANNOTATOR_REMOTE: "true" })).toBe(true);
		expect(isPlannotatorRemote({ PLANNOTATOR_REMOTE: "0" })).toBe(false);
		expect(isPlannotatorRemote({ SSH_TTY: "/dev/pts/1" })).toBe(false);
		expect(isPlannotatorTailscaleEnabled({ PLANNOTATOR_TAILSCALE: "1" })).toBe(true);
		expect(isPlannotatorTailscaleEnabled({ PLANNOTATOR_TAILSCALE: "true" })).toBe(true);
		expect(isPlannotatorTailscaleEnabled({ PLANNOTATOR_TAILSCALE: "0" })).toBe(false);
	});

	test("prefers the Tailscale DNS name and removes its trailing dot", async () => {
		await expect(getTailscaleHost(async () => JSON.stringify({
			Self: {
				DNSName: "agentbox.example.ts.net.",
				HostName: "agentbox",
				TailscaleIPs: ["100.64.0.1"],
			},
		}))).resolves.toBe("agentbox.example.ts.net");
	});

	test("returns undefined when tailscale status is unavailable", async () => {
		await expect(getTailscaleHost(async () => undefined)).resolves.toBeUndefined();
		await expect(getTailscaleHost(async () => "not-json")).resolves.toBeUndefined();
	});
});

describe("Plannotator URL notifications", () => {
	test("colors and underlines the Plannotator URL", () => {
		const { ctx, notifications } = createContext();
		const wrapped = withPlannotatorUrlNotifications(ctx);

		wrapped.ui.notify("[Plannotator] http://localhost:19432", "info");

		expect(notifications).toEqual([{
			message: "[Plannotator] <accent><underline>http://localhost:19432</underline></accent>",
			level: "info",
		}]);
	});

	test("prints a Tailscale URL when a host is available", () => {
		const { ctx, notifications } = createContext();
		const wrapped = withPlannotatorUrlNotifications(ctx, "agentbox.example.ts.net");

		wrapped.ui.notify("[Plannotator] http://localhost:19432/review/abc", "info");

		expect(notifications).toEqual([
			{
				message: "[Plannotator] <accent><underline>http://localhost:19432/review/abc</underline></accent>",
				level: "info",
			},
			{
				message: "[Plannotator] Tailscale: <accent><underline>http://agentbox.example.ts.net:19432/review/abc</underline></accent>",
				level: "info",
			},
		]);
	});

	test("uses an OS-assigned port unless PLANNOTATOR_PORT is explicitly configured", async () => {
		const automaticEnv: NodeJS.ProcessEnv = { PLANNOTATOR_REMOTE: "1" };
		await preparePlannotatorContext(createContext().ctx, { env: automaticEnv });
		expect(automaticEnv.PLANNOTATOR_PORT).toBe("0");

		const fixedEnv: NodeJS.ProcessEnv = {
			PLANNOTATOR_REMOTE: "1",
			PLANNOTATOR_PORT: "43123",
		};
		await preparePlannotatorContext(createContext().ctx, { env: fixedEnv });
		expect(fixedEnv.PLANNOTATOR_PORT).toBe("43123");
	});

	test("fetches Tailscale status only in explicit remote mode", async () => {
		const remote = createContext();
		let calls = 0;
		const remoteCtx = await preparePlannotatorContext(remote.ctx, {
			env: { PLANNOTATOR_REMOTE: "1" },
			runTailscaleStatus: async () => {
				calls += 1;
				return JSON.stringify({ Self: { DNSName: "agentbox.example.ts.net." } });
			},
		});
		remoteCtx.ui.notify("[Plannotator] http://localhost:19432", "info");

		const local = createContext();
		const localCtx = await preparePlannotatorContext(local.ctx, {
			env: {},
			runTailscaleStatus: async () => {
				calls += 1;
				return "{}";
			},
		});
		localCtx.ui.notify("[Plannotator] http://localhost:19432", "info");

		expect(calls).toBe(1);
		expect(remote.notifications).toHaveLength(2);
		expect(local.notifications).toHaveLength(1);
	});

	test("preserves URLs without a trailing slash when replacing the host", () => {
		expect(buildTailscaleUrl("http://localhost:19432", "agentbox.example.ts.net")).toBe(
			"http://agentbox.example.ts.net:19432",
		);
	});
});

describe("first-class Tailscale sessions", () => {
	test("forces loopback mode, publishes HTTPS, and removes the mapping on completion", async () => {
		const env: NodeJS.ProcessEnv = { PLANNOTATOR_TAILSCALE: "1", PLANNOTATOR_REMOTE: "1" };
		const { ctx, notifications } = createContext();
		const preparedCtx = await preparePlannotatorContext(ctx, { env });
		expect(env.PLANNOTATOR_REMOTE).toBe("0");
		expect(env.PLANNOTATOR_PORT).toBe("0");
		expect(env.PLANNOTATOR_URL_HOST).toBe("");

		const calls: string[][] = [];
		const runTailscale = (args: string[]) => {
			calls.push(args);
			if (args[1] === "status") return { status: 0, stdout: "{}", stderr: "" };
			if (args.includes("off")) return { status: 0, stdout: "", stderr: "" };
			return {
				status: 0,
				stdout: "https://agentbox.example.ts.net:43123/\n",
				stderr: "",
			};
		};
		let stopped = 0;
		const session = await preparePlannotatorBrowserSession(preparedCtx, {
			url: "http://localhost:43123/annotate/test",
			waitForDecision: async () => "done",
			stop: () => { stopped += 1; },
		}, {
			env,
			runTailscale,
			writeQr: () => {},
		});

		expect(session.url).toBe("https://agentbox.example.ts.net:43123/annotate/test");
		expect(notifications).toContainEqual({
			message: "[Plannotator] Tailscale: <accent><underline>https://agentbox.example.ts.net:43123/annotate/test</underline></accent>",
			level: "info",
		});
		await expect(session.waitForDecision()).resolves.toBe("done");
		expect(calls).toContainEqual(["serve", "--bg", "--https=43123", "http://127.0.0.1:43123"]);
		expect(calls.at(-1)).toEqual(["serve", "--https=43123", "off"]);
		expect(stopped).toBe(0);
	});

	test("stops the browser session when Tailscale cannot publish it", async () => {
		const { ctx } = createContext();
		let stopped = 0;
		await expect(preparePlannotatorBrowserSession(ctx, {
			url: "http://localhost:43123",
			waitForDecision: async () => "done",
			stop: () => { stopped += 1; },
		}, {
			env: { PLANNOTATOR_TAILSCALE: "1" },
			runTailscale: () => ({ status: 1, stdout: "", stderr: "not signed in" }),
			writeQr: () => {},
		})).rejects.toThrow("not signed in");
		expect(stopped).toBe(1);
	});
});
