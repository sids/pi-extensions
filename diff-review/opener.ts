import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const OPEN_COMMAND_TIMEOUT_MS = 1500;

type ExecResult = {
	stdout: string;
	stderr: string;
	code: number;
	killed?: boolean;
};

export function buildOpenBrowserCommand(url: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
	if (platform === "darwin") {
		return { command: "open", args: [url] };
	}
	if (platform === "win32") {
		return { command: "cmd", args: ["/c", "start", "", url] };
	}
	return { command: "xdg-open", args: [url] };
}

export async function openInDefaultBrowser(pi: ExtensionAPI, cwd: string, url: string): Promise<ExecResult> {
	const { command, args } = buildOpenBrowserCommand(url);
	return await pi.exec(command, args, {
		cwd,
		timeout: OPEN_COMMAND_TIMEOUT_MS,
	});
}
