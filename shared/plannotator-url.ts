import { execFile, spawnSync } from "node:child_process";
import { renderUnicodeCompact } from "uqr";

const URL_PATTERN = /https?:\/\/[^\s]+/g;
const TAILSCALE_CLI_TIMEOUT_MS = 3_000;
const TAILSCALE_SERVE_TIMEOUT_MS = 10_000;
const TAILSCALE_STATE_KEY = Symbol.for("@siddr/pi-extensions/plannotator-tailscale");

type PlannotatorNotificationContext = {
	ui: {
		notify: (message: string, level?: "info" | "warning" | "error") => void;
		theme: {
			fg: (color: "accent", text: string) => string;
			underline: (text: string) => string;
		};
	};
};

type PlannotatorBrowserSession<T> = {
	url: string;
	waitForDecision: () => Promise<T>;
	stop: () => void;
};

type TailscaleStatus = {
	Self?: {
		DNSName?: string;
		HostName?: string;
		TailscaleIPs?: string[];
	};
	TailscaleIPs?: string[];
};

type TailscaleRunResult = {
	error?: Error;
	status: number | null;
	stdout: string;
	stderr: string;
};

export type RunTailscaleStatus = () => Promise<string | undefined>;
export type RunTailscale = (args: string[], timeoutMs: number) => TailscaleRunResult;

type TailscaleState = {
	activePorts: Map<number, RunTailscale>;
	exitHandler?: () => void;
	sighupHandler?: () => void;
};

function getTailscaleState(): TailscaleState {
	const globalState = globalThis as typeof globalThis & { [TAILSCALE_STATE_KEY]?: TailscaleState };
	globalState[TAILSCALE_STATE_KEY] ??= { activePorts: new Map() };
	return globalState[TAILSCALE_STATE_KEY];
}

export function isPlannotatorRemote(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env.PLANNOTATOR_REMOTE?.toLowerCase();
	return value === "1" || value === "true";
}

export function isPlannotatorTailscaleEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env.PLANNOTATOR_TAILSCALE?.toLowerCase();
	return value === "1" || value === "true";
}

function configurePlannotatorNetworkMode(env: NodeJS.ProcessEnv): void {
	if (!env.PLANNOTATOR_PORT?.trim()) {
		// Port 0 asks the OS to allocate a distinct free port for each server,
		// allowing multiple browser sessions to remain open concurrently.
		env.PLANNOTATOR_PORT = "0";
	}
	if (isPlannotatorTailscaleEnabled(env)) {
		// tailscale serve proxies to this process over loopback. Explicitly
		// disable Plannotator remote mode so the review server is never exposed
		// on every network interface while tailnet publishing is enabled.
		env.PLANNOTATOR_REMOTE = "0";
		// The reachable URL comes from tailscale serve. An empty environment
		// value suppresses any persisted display-only host override so the local
		// server does not advertise or warn about a conflicting host.
		env.PLANNOTATOR_URL_HOST = "";
	}
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

function runTailscale(args: string[], timeoutMs: number): TailscaleRunResult {
	const result = spawnSync("tailscale", args, {
		encoding: "utf8",
		windowsHide: true,
		timeout: timeoutMs,
	});
	return {
		error: result.error ?? undefined,
		status: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
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

function describeTailscaleFailure(result: TailscaleRunResult): string {
	if (result.error) {
		const code = (result.error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			return "`tailscale` CLI not found on PATH. Install Tailscale (https://tailscale.com/download) and sign in with `tailscale up`.";
		}
		if (code === "ETIMEDOUT") {
			return "Timed out waiting for the `tailscale` CLI.";
		}
		return result.error.message;
	}
	const detail = result.stderr.trim();
	return `Tailscale is unavailable or not signed in.${detail ? ` ${detail}` : " Run `tailscale up` and retry."}`;
}

function checkServeStatusPort(stdout: string, port: number): "free" | "conflict" | "malformed" {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout.trim());
	} catch {
		return "malformed";
	}
	if (parsed === null) return "free";
	if (typeof parsed !== "object" || Array.isArray(parsed)) return "malformed";

	const checkTcp = (tcp: unknown) => {
		if (tcp === undefined || tcp === null) return "free" as const;
		if (typeof tcp !== "object" || Array.isArray(tcp)) return "malformed" as const;
		return Object.prototype.hasOwnProperty.call(tcp, String(port)) ? "conflict" as const : "free" as const;
	};
	const top = checkTcp((parsed as { TCP?: unknown }).TCP);
	if (top !== "free") return top;

	const foreground = (parsed as { Foreground?: unknown }).Foreground;
	if (foreground === undefined || foreground === null) return "free";
	if (typeof foreground !== "object" || Array.isArray(foreground)) return "malformed";
	for (const session of Object.values(foreground)) {
		if (session === null) continue;
		if (typeof session !== "object" || Array.isArray(session)) return "malformed";
		const result = checkTcp((session as { TCP?: unknown }).TCP);
		if (result !== "free") return result;
	}
	return "free";
}

function extractServeHttpsUrl(output: string, expectedPort: number): string | undefined {
	for (const match of output.matchAll(/https:\/\/[^\s|]+/g)) {
		const candidate = match[0].replace(/\/+$/, "");
		try {
			const url = new URL(candidate);
			if (url.protocol === "https:" && url.hostname && Number(url.port || "443") === expectedPort) {
				return candidate;
			}
		} catch {
			// Ignore unrelated text that merely resembles a URL.
		}
	}
	return undefined;
}

function runServeOff(port: number, run: RunTailscale): boolean {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			const result = run(["serve", `--https=${port}`, "off"], TAILSCALE_SERVE_TIMEOUT_MS);
			if (!result.error && result.status === 0) return true;
		} catch {
			// Retry once before reporting the leaked mapping.
		}
	}
	return false;
}

function warnLeakedMapping(port: number): void {
	process.stderr.write(
		`[plannotator] Warning: could not remove the tailscale serve mapping for port ${port}. `
		+ `Remove it manually with: tailscale serve --https=${port} off\n`,
	);
}

function disableTailscaleServe(port: number, run?: RunTailscale): void {
	const state = getTailscaleState();
	const activeRunner = state.activePorts.get(port);
	if (!activeRunner) return;
	if (runServeOff(port, run ?? activeRunner)) {
		state.activePorts.delete(port);
	} else {
		warnLeakedMapping(port);
	}
}

function cleanupTailscaleServeMappings(): void {
	const state = getTailscaleState();
	for (const [port, run] of [...state.activePorts]) {
		disableTailscaleServe(port, run);
	}
}

function installTailscaleCleanup(): void {
	const state = getTailscaleState();
	if (state.exitHandler) return;
	state.exitHandler = cleanupTailscaleServeMappings;
	state.sighupHandler = () => process.exit(129);
	process.on("exit", state.exitHandler);
	process.once("SIGHUP", state.sighupHandler);
}

function enableTailscaleServe(port: number, run: RunTailscale): string {
	const status = run(["serve", "status", "--json"], TAILSCALE_SERVE_TIMEOUT_MS);
	if (status.error || status.status !== 0) {
		throw new Error(`Tailscale: ${describeTailscaleFailure(status)}`);
	}
	const portStatus = checkServeStatusPort(status.stdout, port);
	if (portStatus === "malformed") {
		throw new Error("Tailscale: could not parse `tailscale serve status --json`; refusing to modify the serve configuration.");
	}
	if (portStatus === "conflict") {
		throw new Error(
			`Tailscale already routes port ${port}. Clear it with \`tailscale serve --https=${port} off\` or set PLANNOTATOR_PORT to a free port.`,
		);
	}

	const serve = run(
		["serve", "--bg", `--https=${port}`, `http://127.0.0.1:${port}`],
		TAILSCALE_SERVE_TIMEOUT_MS,
	);
	if (serve.error || serve.status !== 0) {
		throw new Error(`Tailscale: could not start tailscale serve. ${describeTailscaleFailure(serve)}`);
	}
	const url = extractServeHttpsUrl(`${serve.stdout}\n${serve.stderr}`, port);
	if (!url) {
		if (!runServeOff(port, run)) warnLeakedMapping(port);
		throw new Error(`Tailscale: could not find an HTTPS URL for port ${port} in \`tailscale serve\` output.`);
	}
	getTailscaleState().activePorts.set(port, run);
	installTailscaleCleanup();
	return url;
}

function writeUrlQr(url: string): void {
	if (!process.stderr.isTTY) return;
	try {
		const qr = renderUnicodeCompact(url)
			.split("\n")
			.map((line) => `  ${line}`)
			.join("\n");
		process.stderr.write(`${qr}\n\n`);
	} catch {
		// A QR code is a convenience and must not break a review session.
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
	const env = options.env ?? process.env;
	const tailscaleEnabled = isPlannotatorTailscaleEnabled(env);
	configurePlannotatorNetworkMode(env);
	const tailscaleHost = !tailscaleEnabled && isPlannotatorRemote(env)
		? await getTailscaleHost(options.runTailscaleStatus)
		: undefined;
	return withPlannotatorUrlNotifications(ctx, tailscaleHost);
}

export async function preparePlannotatorBrowserSession<
	T,
	S extends PlannotatorBrowserSession<T>,
>(
	ctx: PlannotatorNotificationContext,
	session: S,
	options: {
		env?: NodeJS.ProcessEnv;
		runTailscale?: RunTailscale;
		writeQr?: (url: string) => void;
	} = {},
): Promise<S> {
	const env = options.env ?? process.env;
	if (!isPlannotatorTailscaleEnabled(env)) return session;

	let localUrl: URL;
	try {
		localUrl = new URL(session.url);
	} catch {
		session.stop();
		throw new Error(`Tailscale: Plannotator returned an invalid session URL: ${session.url}`);
	}
	const port = Number(localUrl.port);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		session.stop();
		throw new Error(`Tailscale: Plannotator session URL has no publishable port: ${session.url}`);
	}

	let publishedOrigin: string;
	try {
		publishedOrigin = enableTailscaleServe(port, options.runTailscale ?? runTailscale);
	} catch (error) {
		session.stop();
		throw error;
	}
	const publishedUrl = new URL(publishedOrigin);
	publishedUrl.pathname = localUrl.pathname;
	publishedUrl.search = localUrl.search;
	publishedUrl.hash = localUrl.hash;
	const url = publishedUrl.toString().replace(/\/$/, localUrl.pathname === "/" ? "" : "/");
	ctx.ui.notify(`[Plannotator] Tailscale: ${url}`, "info");
	(options.writeQr ?? writeUrlQr)(url);

	let cleanedUp = false;
	const cleanup = () => {
		if (cleanedUp) return;
		cleanedUp = true;
		disableTailscaleServe(port, options.runTailscale);
	};
	const wrapped = {
		...session,
		url,
		async waitForDecision() {
			try {
				return await session.waitForDecision();
			} finally {
				cleanup();
			}
		},
		stop() {
			try {
				session.stop();
			} finally {
				cleanup();
			}
		},
	};
	return wrapped as S;
}

export function resetPlannotatorTailscaleForTests(): void {
	const state = getTailscaleState();
	state.activePorts.clear();
	if (state.exitHandler) process.removeListener("exit", state.exitHandler);
	if (state.sighupHandler) process.removeListener("SIGHUP", state.sighupHandler);
	state.exitHandler = undefined;
	state.sighupHandler = undefined;
}
