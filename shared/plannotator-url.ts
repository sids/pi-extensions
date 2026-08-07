import { execFile } from "node:child_process";

const URL_PATTERN = /https?:\/\/[^\s]+/g;

type PlannotatorNotificationContext = {
	ui: {
		notify: (message: string, level?: "info" | "warning" | "error") => void;
		theme: {
			fg: (color: "accent", text: string) => string;
			underline: (text: string) => string;
		};
	};
};

type TailscaleStatus = {
	Self?: {
		DNSName?: string;
		HostName?: string;
		TailscaleIPs?: string[];
	};
	TailscaleIPs?: string[];
};

export type RunTailscaleStatus = () => Promise<string | undefined>;

export function isPlannotatorRemote(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env.PLANNOTATOR_REMOTE?.toLowerCase();
	return value === "1" || value === "true";
}

async function runTailscaleStatus(): Promise<string | undefined> {
	return await new Promise((resolve) => {
		execFile(
			"tailscale",
			["status", "--json"],
			{ encoding: "utf8", timeout: 5_000, maxBuffer: 1024 * 1024 },
			(error, stdout) => resolve(error ? undefined : stdout),
		);
	});
}

function normalizeTailscaleHost(host: string | undefined): string | undefined {
	const normalized = host?.trim().replace(/\.$/, "");
	return normalized || undefined;
}

export async function getTailscaleHost(
	runStatus: RunTailscaleStatus = runTailscaleStatus,
): Promise<string | undefined> {
	try {
		const output = await runStatus();
		if (!output) {
			return undefined;
		}
		const status = JSON.parse(output) as TailscaleStatus;
		return normalizeTailscaleHost(status.Self?.DNSName)
			?? normalizeTailscaleHost(status.Self?.HostName)
			?? normalizeTailscaleHost(status.Self?.TailscaleIPs?.find((address) => !address.includes(":")))
			?? normalizeTailscaleHost(status.TailscaleIPs?.find((address) => !address.includes(":")));
	} catch {
		return undefined;
	}
}

export function buildTailscaleUrl(url: string, tailscaleHost: string): string | undefined {
	try {
		const parsed = new URL(url);
		parsed.hostname = tailscaleHost;
		const result = parsed.toString();
		return !url.endsWith("/") && parsed.pathname === "/" && !parsed.search && !parsed.hash
			? result.slice(0, -1)
			: result;
	} catch {
		return undefined;
	}
}

export function withPlannotatorUrlNotifications<T extends PlannotatorNotificationContext>(
	ctx: T,
	tailscaleHost?: string,
): T {
	const formatUrl = (url: string) => ctx.ui.theme.fg("accent", ctx.ui.theme.underline(url));
	const ui = new Proxy(ctx.ui, {
		get(target, property, receiver) {
			if (property === "notify") {
				return (message: string, level?: "info" | "warning" | "error") => {
					const urls = message.match(URL_PATTERN) ?? [];
					const firstUrl = urls[0];
					target.notify(message.replace(URL_PATTERN, formatUrl), level);

					if (!tailscaleHost || !firstUrl) {
						return;
					}
					const tailscaleUrl = buildTailscaleUrl(firstUrl, tailscaleHost);
					if (!tailscaleUrl || tailscaleUrl === firstUrl) {
						return;
					}
					target.notify(`[Plannotator] Tailscale: ${formatUrl(tailscaleUrl)}`, level);
				};
			}
			const value = Reflect.get(target, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});

	return new Proxy(ctx, {
		get(target, property, receiver) {
			return property === "ui" ? ui : Reflect.get(target, property, receiver);
		},
	});
}

export async function preparePlannotatorContext<T extends PlannotatorNotificationContext>(
	ctx: T,
	options: {
		env?: NodeJS.ProcessEnv;
		runTailscaleStatus?: RunTailscaleStatus;
	} = {},
): Promise<T> {
	const tailscaleHost = isPlannotatorRemote(options.env)
		? await getTailscaleHost(options.runTailscaleStatus)
		: undefined;
	return withPlannotatorUrlNotifications(ctx, tailscaleHost);
}
