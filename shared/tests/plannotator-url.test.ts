import { describe, expect, test } from "vitest";
import {
	buildTailscaleUrl,
	getTailscaleHost,
	isPlannotatorRemote,
	preparePlannotatorContext,
	withPlannotatorUrlNotifications,
} from "../plannotator-url";

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
	test("recognizes explicit Plannotator remote mode", () => {
		expect(isPlannotatorRemote({ PLANNOTATOR_REMOTE: "1" })).toBe(true);
		expect(isPlannotatorRemote({ PLANNOTATOR_REMOTE: "true" })).toBe(true);
		expect(isPlannotatorRemote({ PLANNOTATOR_REMOTE: "0" })).toBe(false);
		expect(isPlannotatorRemote({ SSH_TTY: "/dev/pts/1" })).toBe(false);
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
