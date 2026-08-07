import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CodeReviewResult } from "./index";

function quoteGitPath(value: string): string {
	return /[\s"\\]/.test(value) ? JSON.stringify(value) : value;
}

async function getInitialRepoPaths(pi: ExtensionAPI, cwd: string): Promise<string[]> {
	const result = await pi.exec("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd });
	if (result.code !== 0 || !result.stdout.trim()) {
		return [];
	}
	return [...new Set(result.stdout
		.trim()
		.split(/\r?\n/)
		.map((value) => value.trim())
		.filter((value) => value.length > 0))];
}

async function synthesizeAddedFilePatch(pi: ExtensionAPI, repoRoot: string, relativePath: string): Promise<string> {
	const result = await pi.exec(
		"git",
		[
			"diff",
			"--no-index",
			"--no-color",
			"--no-ext-diff",
			"--src-prefix=a/",
			"--dst-prefix=b/",
			"--relative",
			"--",
			"/dev/null",
			relativePath,
		],
		{ cwd: repoRoot },
	);
	if (result.stdout.trim()) {
		return result.stdout;
	}

	let content: Buffer;
	try {
		content = await readFile(path.join(repoRoot, relativePath));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return "";
		}
		throw error;
	}
	if (content.includes(0)) {
		return [
			`diff --git a/${quoteGitPath(relativePath)} b/${quoteGitPath(relativePath)}`,
			"new file mode 100644",
			`Binary files /dev/null and b/${quoteGitPath(relativePath)} differ`,
		].join("\n");
	}

	const text = content.toString("utf8").replace(/\r\n/g, "\n");
	const contentLines = text.length === 0 ? [] : text.split("\n");
	const normalizedLines = text.endsWith("\n") ? contentLines.slice(0, -1) : contentLines;
	return [
		`diff --git a/${quoteGitPath(relativePath)} b/${quoteGitPath(relativePath)}`,
		"new file mode 100644",
		"--- /dev/null",
		`+++ b/${quoteGitPath(relativePath)}`,
		`@@ -0,0 +1,${normalizedLines.length} @@`,
		...normalizedLines.map((line) => `+${line}`),
	].join("\n");
}

export async function buildUnbornRepoPatch(pi: ExtensionAPI, cwd: string): Promise<string> {
	const paths = await getInitialRepoPaths(pi, cwd);
	const patches: string[] = [];
	for (const relativePath of paths) {
		patches.push(await synthesizeAddedFilePatch(pi, cwd, relativePath));
	}
	return patches.filter((patch) => patch.trim()).join("\n");
}

export async function openUnbornRepoReview(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	cwd: string,
): Promise<CodeReviewResult> {
	const [serverModule, browserRuntime, browserModule] = await Promise.all([
		import("@plannotator/pi-extension/server.ts"),
		import("@plannotator/pi-extension/plannotator-browser-runtime.ts"),
		import("@plannotator/pi-extension/plannotator-browser.ts"),
	]);
	const htmlContent = browserRuntime.getReviewBrowserHtml();
	if (!htmlContent) {
		throw new Error("Plannotator code review browser is unavailable in this session.");
	}

	const rawPatch = await buildUnbornRepoPatch(pi, cwd);
	const server = await browserModule.startServerWithSelfPreemption(() => serverModule.startReviewServer({
		rawPatch,
		gitRef: "Uncommitted changes",
		htmlContent,
		origin: "pi",
		diffType: "uncommitted",
		agentCwd: cwd,
	}));
	const session = browserModule.startBrowserDecisionSession(server, ctx, server.waitForDecision);
	return await session.waitForDecision();
}
