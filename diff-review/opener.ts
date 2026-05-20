import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const OPEN_COMMAND_TIMEOUT_MS = 1500;
const GLIMPSE_COMMAND = "glimpseui";

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

export function buildGlimpseHtml(url: string): string {
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>pi diff review</title>
	<style>
		html,
		body,
		iframe {
			width: 100%;
			height: 100%;
			margin: 0;
			border: 0;
			background: #070a0f;
		}
	</style>
</head>
<body>
	<iframe src=${JSON.stringify(url)} title="pi diff review"></iframe>
</body>
</html>`;
}

export async function isGlimpseInstalled(pi: ExtensionAPI, cwd: string): Promise<boolean> {
	try {
		const result = await pi.exec(GLIMPSE_COMMAND, ["--help"], {
			cwd,
			timeout: OPEN_COMMAND_TIMEOUT_MS,
		});
		return result.code === 0;
	} catch {
		return false;
	}
}

export async function openInDefaultBrowser(pi: ExtensionAPI, cwd: string, url: string): Promise<ExecResult> {
	const { command, args } = buildOpenBrowserCommand(url);
	return await pi.exec(command, args, {
		cwd,
		timeout: OPEN_COMMAND_TIMEOUT_MS,
	});
}

export async function openInGlimpse(pi: ExtensionAPI, cwd: string, url: string): Promise<ExecResult> {
	const dir = await mkdtemp(path.join(tmpdir(), "pi-diff-review-glimpse-"));
	const htmlPath = path.join(dir, "review.html");
	await writeFile(htmlPath, buildGlimpseHtml(url), "utf8");
	const script = `
const { spawn } = require("node:child_process");
const command = process.platform === "win32" ? "${GLIMPSE_COMMAND}.cmd" : "${GLIMPSE_COMMAND}";
const child = spawn(command, ["--width", "1400", "--height", "900", "--title", "pi diff review", process.argv[1]], {
	detached: true,
	stdio: "ignore",
	windowsHide: true,
});
child.unref();
`;
	return await pi.exec(process.execPath, ["-e", script, htmlPath], {
		cwd,
		timeout: OPEN_COMMAND_TIMEOUT_MS,
	});
}
