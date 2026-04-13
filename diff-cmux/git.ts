import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { File as ParsedDiffFile } from "gitdiff-parser";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { parseDiff } from "react-diff-view";
import type { DiffFileEntry, DiffFilePayload, DiffFileStatus, DiffTarget, DiffViewerData, RepoMetadata, ResolvedDiffTarget } from "./types";

const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const GIT_DIFF_ARGS = ["diff", "--no-color", "--no-ext-diff", "--find-renames", "--unified=3"];
const FILTERED_PATH_PATTERNS = [/\.min\.(?:js|mjs|cjs|css)$/i, /\.(?:png|jpe?g|gif|webp|ico|bmp|tiff|avif|woff2?|eot|ttf|otf|zip|gz|bz2|7z|rar|pdf|mp4|mov|avi|webm|mp3|wav|ogg)$/i];
const BINARY_PATH_PATTERNS = [/\.(?:png|jpe?g|gif|webp|ico|bmp|tiff|avif|woff2?|eot|ttf|otf|zip|gz|bz2|7z|rar|pdf|mp4|mov|avi|webm|mp3|wav|ogg)$/i];

type ExecResult = {
	stdout: string;
	stderr: string;
	code: number;
	killed?: boolean;
};

type RawDiffFile = {
	parsed: ParsedDiffFile;
	rawPatch: string;
};

export type DefaultBranchInfo = {
	branch: string;
	isReliable: boolean;
};

async function exec(pi: ExtensionAPI, command: string, args: string[], cwd?: string): Promise<ExecResult> {
	return await pi.exec(command, args, cwd ? { cwd } : undefined);
}

function normalizeGitPath(value: string): string {
	return value.split(path.sep).join("/");
}

function quoteGitPath(value: string): string {
	if (!/[\s"\\]/.test(value)) {
		return value;
	}
	return JSON.stringify(value);
}

function sanitizeAnchorSegment(value: string): string {
	return value.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "file";
}

function hashText(value: string): string {
	return createHash("sha1").update(value).digest("hex").slice(0, 12);
}

function mapParsedDiffType(type: ParsedDiffFile["type"]): DiffFileStatus {
	switch (type) {
		case "add":
			return "added";
		case "delete":
			return "deleted";
		case "rename":
			return "renamed";
		default:
			return "modified";
	}
}

function parseDiffIntoFiles(diffText: string): RawDiffFile[] {
	const normalized = diffText.replace(/\r\n/g, "\n").trim();
	if (!normalized) {
		return [];
	}

	const patches = normalized
		.split(/^diff --git /m)
		.map((chunk, index) => (index === 0 ? chunk : `diff --git ${chunk}`))
		.map((chunk) => chunk.trim())
		.filter((chunk) => chunk.length > 0);
	const parsedFiles = parseDiff(normalized, { nearbySequences: "zip" });
	return parsedFiles.map((parsed, index) => ({
		parsed,
		rawPatch: patches[index] ?? "",
	}));
}

async function runGitDiff(pi: ExtensionAPI, cwd: string, args: string[]): Promise<string> {
	const result = await exec(pi, "git", [...GIT_DIFF_ARGS, ...args], cwd);
	if (result.code !== 0) {
		throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`);
	}
	return result.stdout;
}

async function getCommitTitle(pi: ExtensionAPI, sha: string, cwd?: string): Promise<string | null> {
	const { stdout, code } = await exec(pi, "git", ["show", "--no-patch", "--format=%s", sha], cwd);
	if (code !== 0) {
		return null;
	}
	const title = stdout.trim();
	return title || null;
}

async function getCommitParent(pi: ExtensionAPI, sha: string, cwd?: string): Promise<string> {
	const { stdout, code } = await exec(pi, "git", ["rev-parse", `${sha}^`], cwd);
	if (code !== 0) {
		return EMPTY_TREE_SHA;
	}
	const parent = stdout.trim();
	return parent || EMPTY_TREE_SHA;
}

async function getUntrackedPaths(pi: ExtensionAPI, cwd: string): Promise<string[]> {
	const { stdout, code } = await exec(pi, "git", ["ls-files", "--others", "--exclude-standard"], cwd);
	if (code !== 0 || !stdout.trim()) {
		return [];
	}
	return stdout
		.trim()
		.split(/\r?\n/)
		.map((value) => value.trim())
		.filter((value) => value.length > 0);
}

async function getInitialRepoPaths(pi: ExtensionAPI, cwd: string): Promise<string[]> {
	const { stdout, code } = await exec(pi, "git", ["ls-files", "--cached", "--others", "--exclude-standard"], cwd);
	if (code !== 0 || !stdout.trim()) {
		return [];
	}
	return stdout
		.trim()
		.split(/\r?\n/)
		.map((value) => value.trim())
		.filter((value) => value.length > 0);
}

async function synthesizeAddedFilePatch(pi: ExtensionAPI, repoRoot: string, relativePath: string): Promise<string> {
	const absolutePath = path.join(repoRoot, relativePath);
	const result = await exec(
		pi,
		"git",
		[
			"diff",
			"--no-index",
			"--no-color",
			"--no-ext-diff",
			"--src-prefix=a/",
			"--dst-prefix=b/",
			"--relative",
			"--unified=3",
			"--",
			"/dev/null",
			relativePath,
		],
		repoRoot,
	);
	if (result.stdout.trim()) {
		return result.stdout;
	}

	const content = await readFile(absolutePath);
	const isBinary = content.includes(0);
	if (isBinary) {
		return [
			`diff --git a/${quoteGitPath(relativePath)} b/${quoteGitPath(relativePath)}`,
			"new file mode 100644",
			`Binary files /dev/null and b/${quoteGitPath(relativePath)} differ`,
		].join("\n");
	}

	const text = content.toString("utf8").replace(/\r\n/g, "\n");
	const contentLines = text.length === 0 ? [] : text.split("\n");
	const normalizedLines = text.endsWith("\n") ? contentLines.slice(0, -1) : contentLines;
	const newLines = normalizedLines.length;
	const addedLines = normalizedLines.map((line) => `+${line}`);
	return [
		`diff --git a/${quoteGitPath(relativePath)} b/${quoteGitPath(relativePath)}`,
		"new file mode 100644",
		"--- /dev/null",
		`+++ b/${quoteGitPath(relativePath)}`,
		`@@ -0,0 +1,${newLines} @@`,
		...addedLines,
	].join("\n");
}

function buildFileEntry(rawFile: RawDiffFile, index: number): DiffFileEntry {
	const status = mapParsedDiffType(rawFile.parsed.type);
	const oldPath = rawFile.parsed.oldPath || null;
	const newPath = rawFile.parsed.newPath || null;
	const displayPath = status === "deleted" ? oldPath ?? newPath ?? "(unknown)" : newPath ?? oldPath ?? "(unknown)";
	const stableId = hashText([status, oldPath ?? "", newPath ?? "", displayPath].join("\u0000"));
	return {
		id: `file-${stableId}`,
		path: displayPath,
		oldPath,
		newPath,
		status,
		anchorId: `diff-file-${index + 1}-${sanitizeAnchorSegment(displayPath)}`,
		isBinary: rawFile.parsed.isBinary === true || /(?:^|\n)(?:GIT binary patch|Binary files )/m.test(rawFile.rawPatch),
		fingerprint: hashText(rawFile.rawPatch || [status, oldPath ?? "", newPath ?? "", displayPath].join("\u0000")),
	};
}

async function loadRawDiffFilesForTarget(pi: ExtensionAPI, repoRoot: string, target: ResolvedDiffTarget): Promise<RawDiffFile[]> {
	let rawFiles: RawDiffFile[] = [];

	if (target.type === "uncommitted") {
		if (target.hasHead) {
			const trackedDiff = await runGitDiff(pi, repoRoot, ["HEAD", "--"]);
			rawFiles = parseDiffIntoFiles(trackedDiff);
			const untrackedPaths = await getUntrackedPaths(pi, repoRoot);
			for (const relativePath of untrackedPaths) {
				const patch = await synthesizeAddedFilePatch(pi, repoRoot, relativePath);
				rawFiles.push(...parseDiffIntoFiles(patch));
			}
		} else {
			const paths = await getInitialRepoPaths(pi, repoRoot);
			for (const relativePath of paths) {
				const patch = await synthesizeAddedFilePatch(pi, repoRoot, relativePath);
				rawFiles.push(...parseDiffIntoFiles(patch));
			}
		}
		return rawFiles;
	}

	if (!target.baseRev || !target.headRev) {
		return [];
	}

	const diffText = await runGitDiff(pi, repoRoot, [target.baseRev, target.headRev, "--"]);
	return parseDiffIntoFiles(diffText);
}

export async function isGitRepository(pi: ExtensionAPI, cwd: string): Promise<boolean> {
	const { code } = await exec(pi, "git", ["rev-parse", "--git-dir"], cwd);
	return code === 0;
}

export async function getRepoRoot(pi: ExtensionAPI, cwd: string): Promise<string | null> {
	const { stdout, code } = await exec(pi, "git", ["rev-parse", "--show-toplevel"], cwd);
	if (code !== 0) {
		return null;
	}
	const repoRoot = stdout.trim();
	return repoRoot || null;
}

export async function hasHeadCommit(pi: ExtensionAPI, cwd: string): Promise<boolean> {
	const { code } = await exec(pi, "git", ["rev-parse", "--verify", "HEAD^{commit}"], cwd);
	return code === 0;
}

export async function hasWorkingTreeChanges(pi: ExtensionAPI, cwd: string): Promise<boolean> {
	const { stdout, code } = await exec(pi, "git", ["status", "--porcelain"], cwd);
	return code === 0 && stdout.trim().length > 0;
}

export async function getCurrentBranch(pi: ExtensionAPI, cwd?: string): Promise<string | null> {
	const { stdout, code } = await exec(pi, "git", ["branch", "--show-current"], cwd);
	if (code !== 0) {
		return null;
	}
	const branch = stdout.trim();
	return branch || null;
}

export async function getLocalBranches(pi: ExtensionAPI, cwd?: string): Promise<string[]> {
	const { stdout, code } = await exec(pi, "git", ["branch", "--format=%(refname:short)"], cwd);
	if (code !== 0 || !stdout.trim()) {
		return [];
	}
	return stdout
		.trim()
		.split(/\r?\n/)
		.map((branch) => branch.trim())
		.filter((branch) => branch.length > 0);
}

export async function getRecentCommits(pi: ExtensionAPI, limit = 20, cwd?: string): Promise<Array<{ sha: string; title: string }>> {
	const { stdout, code } = await exec(pi, "git", ["log", "--oneline", "-n", String(limit)], cwd);
	if (code !== 0 || !stdout.trim()) {
		return [];
	}
	return stdout
		.trim()
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => {
			const [sha, ...titleParts] = line.split(" ");
			return {
				sha,
				title: titleParts.join(" "),
			};
		});
}

export async function getDefaultBranchInfo(pi: ExtensionAPI, cwd?: string): Promise<DefaultBranchInfo> {
	const { stdout, code } = await exec(pi, "git", ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"], cwd);
	if (code === 0 && stdout.trim()) {
		return {
			branch: stdout.trim().replace(/^origin\//, ""),
			isReliable: true,
		};
	}

	const branches = await getLocalBranches(pi, cwd);
	if (branches.includes("main")) {
		return { branch: "main", isReliable: false };
	}
	if (branches.includes("master")) {
		return { branch: "master", isReliable: false };
	}
	return { branch: "main", isReliable: false };
}

export async function getDefaultBranch(pi: ExtensionAPI, cwd?: string): Promise<string> {
	return (await getDefaultBranchInfo(pi, cwd)).branch;
}

export async function getMergeBase(pi: ExtensionAPI, branch: string, cwd?: string): Promise<string | null> {
	const upstream = await exec(pi, "git", ["rev-parse", "--abbrev-ref", `${branch}@{upstream}`], cwd);
	if (upstream.code === 0 && upstream.stdout.trim()) {
		const mergeBase = await exec(pi, "git", ["merge-base", "HEAD", upstream.stdout.trim()], cwd);
		if (mergeBase.code === 0 && mergeBase.stdout.trim()) {
			return mergeBase.stdout.trim();
		}
	}

	const mergeBase = await exec(pi, "git", ["merge-base", "HEAD", branch], cwd);
	if (mergeBase.code !== 0) {
		return null;
	}
	const value = mergeBase.stdout.trim();
	return value || null;
}

export function shouldFilterDiffPath(filePath: string): boolean {
	return FILTERED_PATH_PATTERNS.some((pattern) => pattern.test(filePath));
}

export function isLikelyBinaryPath(filePath: string): boolean {
	return BINARY_PATH_PATTERNS.some((pattern) => pattern.test(filePath));
}

export async function resolveDiffTarget(pi: ExtensionAPI, cwd: string, target: DiffTarget): Promise<ResolvedDiffTarget | null> {
	const hasHead = await hasHeadCommit(pi, cwd);
	if (target.type === "uncommitted") {
		return {
			type: "uncommitted",
			label: "Uncommitted changes",
			subtitle: hasHead ? "Working tree compared with HEAD" : "Working tree compared with the empty tree",
			baseRev: hasHead ? "HEAD" : EMPTY_TREE_SHA,
			headRev: hasHead ? "HEAD" : null,
			hasHead,
		};
	}

	if (target.type === "baseBranch") {
		const mergeBase = hasHead ? await getMergeBase(pi, target.branch, cwd) : EMPTY_TREE_SHA;
		if (!mergeBase) {
			return null;
		}
		return {
			type: "baseBranch",
			branch: target.branch,
			label: `Branch ${target.branch}`,
			subtitle: `Changes since the merge-base with ${target.branch}`,
			baseRev: mergeBase,
			headRev: hasHead ? "HEAD" : null,
			hasHead,
		};
	}

	const title = target.title ?? (await getCommitTitle(pi, target.sha, cwd)) ?? "Commit";
	const baseRev = await getCommitParent(pi, target.sha, cwd);
	return {
		type: "commit",
		sha: target.sha,
		title,
		label: `${target.sha.slice(0, 7)} ${title}`.trim(),
		subtitle: baseRev === EMPTY_TREE_SHA ? "Root commit compared with the empty tree" : `Commit ${target.sha.slice(0, 7)} compared with its parent`,
		baseRev,
		headRev: target.sha,
		hasHead,
	};
}

export async function buildDiffViewerData(pi: ExtensionAPI, cwd: string, target: DiffTarget): Promise<DiffViewerData> {
	const repoRoot = await getRepoRoot(pi, cwd);
	if (!repoRoot) {
		throw new Error("Could not determine the git repository root.");
	}
	const repo: RepoMetadata = {
		root: repoRoot,
		name: path.basename(repoRoot),
		cwd,
	};
	const resolvedTarget = await resolveDiffTarget(pi, repoRoot, target);
	if (!resolvedTarget) {
		throw new Error("Could not resolve the selected diff target.");
	}

	const rawFiles = await loadRawDiffFilesForTarget(pi, repoRoot, resolvedTarget);
	const visibleRawFiles = rawFiles.filter((rawFile) => {
		const candidatePath = rawFile.parsed.newPath || rawFile.parsed.oldPath || "";
		return !shouldFilterDiffPath(candidatePath);
	});

	const files: DiffFileEntry[] = [];
	const filePayloads = new Map<string, DiffFilePayload>();
	for (const [index, rawFile] of visibleRawFiles.entries()) {
		const file = buildFileEntry(rawFile, index);
		if (!file.isBinary && isLikelyBinaryPath(file.path)) {
			file.isBinary = true;
		}
		files.push(file);
		filePayloads.set(file.id, {
			file,
			diffText: file.isBinary ? null : rawFile.rawPatch,
			message: file.isBinary ? "Binary or unrenderable file" : undefined,
		});
	}

	return {
		repo,
		target: resolvedTarget,
		files,
		filePayloads,
	};
}
