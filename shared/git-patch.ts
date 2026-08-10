import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function quoteGitPath(value: string): string {
	return /[\s"\\]/u.test(value) ? JSON.stringify(value) : value;
}

async function listPaths(pi: ExtensionAPI, repoRoot: string, args: string[]): Promise<string[]> {
	const result = await pi.exec("git", ["ls-files", ...args], { cwd: repoRoot });
	return result.code === 0 && result.stdout.trim()
		? [...new Set(result.stdout.trim().split(/\r?\n/u).map((value) => value.trim()).filter(Boolean))]
		: [];
}

function getUntrackedPaths(pi: ExtensionAPI, repoRoot: string): Promise<string[]> {
	return listPaths(pi, repoRoot, ["--others", "--exclude-standard"]);
}

async function buildAddedFilePatch(
	pi: ExtensionAPI,
	repoRoot: string,
	relativePath: string,
): Promise<string> {
	const result = await pi.exec("git", [
		"diff", "--no-index", "--no-color", "--no-ext-diff",
		"--src-prefix=a/", "--dst-prefix=b/", "--relative", "--", "/dev/null", relativePath,
	], { cwd: repoRoot });
	if (result.stdout.trim()) return result.stdout.trimEnd();

	let content: Buffer;
	try {
		content = await readFile(path.join(repoRoot, relativePath));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw error;
	}
	const quotedPath = quoteGitPath(relativePath);
	const header = [`diff --git a/${quotedPath} b/${quotedPath}`, "new file mode 100644"];
	if (content.includes(0)) {
		return [...header, `Binary files /dev/null and b/${quotedPath} differ`].join("\n");
	}
	const text = content.toString("utf8").replace(/\r\n/gu, "\n");
	if (!text) return header.join("\n");
	const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
	return [
		...header,
		"--- /dev/null",
		`+++ b/${quotedPath}`,
		`@@ -0,0 +1,${lines.length} @@`,
		...lines.map((line) => `+${line}`),
	].join("\n");
}

async function buildFilesPatch(pi: ExtensionAPI, repoRoot: string, paths: string[]): Promise<string> {
	return (await Promise.all(paths.map((relativePath) => buildAddedFilePatch(pi, repoRoot, relativePath))))
		.filter((patch) => patch.trim())
		.join("\n");
}

export async function buildUntrackedFilesPatch(pi: ExtensionAPI, repoRoot: string): Promise<string> {
	return await buildFilesPatch(pi, repoRoot, await getUntrackedPaths(pi, repoRoot));
}

export async function buildUnbornFilesPatch(pi: ExtensionAPI, repoRoot: string): Promise<string> {
	return await buildFilesPatch(pi, repoRoot, await listPaths(pi, repoRoot, ["--cached", "--others", "--exclude-standard"]));
}
