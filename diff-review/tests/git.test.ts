import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, renameSync, unlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildDiffReviewData, getMergeBase, getRepoRoot, hasHeadCommit, isGitRepository, resolveDiffTarget } from "../git";
import type { DiffTarget } from "../types";

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		rmSync(tempDirs.pop()!, { recursive: true, force: true });
	}
});

function createTempRepo(): string {
	const repoRoot = mkdtempSync(path.join(tmpdir(), "pi-diff-review-"));
	tempDirs.push(repoRoot);
	run("git", ["init", "-q", "-b", "main"], repoRoot);
	run("git", ["config", "user.email", "sid@example.com"], repoRoot);
	run("git", ["config", "user.name", "Sid"], repoRoot);
	return repoRoot;
}

function run(command: string, args: string[], cwd: string) {
	const result = spawnSync(command, args, { cwd, encoding: "utf8" });
	if ((result.status ?? 1) !== 0) {
		throw new Error(`Command failed: ${command} ${args.join(" ")}\n${result.stderr}`);
	}
	return result.stdout;
}

function write(repoRoot: string, relativePath: string, contents: string | Buffer) {
	const absolutePath = path.join(repoRoot, relativePath);
	mkdirSync(path.dirname(absolutePath), { recursive: true });
	writeFileSync(absolutePath, contents);
}

function commitAll(repoRoot: string, message: string): string {
	run("git", ["add", "."], repoRoot);
	run("git", ["commit", "-q", "-m", message], repoRoot);
	return run("git", ["rev-parse", "HEAD"], repoRoot).trim();
}

function createPi() {
	return {
		exec: async (command: string, args: string[], options?: { cwd?: string }) => {
			const result = spawnSync(command, args, {
				cwd: options?.cwd,
				encoding: "utf8",
			});
			return {
				stdout: result.stdout,
				stderr: result.stderr,
				code: result.status ?? 1,
				killed: false,
			};
		},
	} as any;
}

async function buildReview(repoRoot: string, target: DiffTarget) {
	return await buildDiffReviewData(createPi(), repoRoot, target);
}

describe("git helpers", () => {
	test("detects git repositories and whether HEAD exists", async () => {
		const repoRoot = createTempRepo();
		const pi = createPi();

		await expect(isGitRepository(pi, repoRoot)).resolves.toBe(true);
		await expect(getRepoRoot(pi, repoRoot)).resolves.toBe(realpathSync(repoRoot));
		await expect(hasHeadCommit(pi, repoRoot)).resolves.toBe(false);

		write(repoRoot, "README.md", "hello\n");
		commitAll(repoRoot, "Initial commit");
		await expect(hasHeadCommit(pi, repoRoot)).resolves.toBe(true);
	});

	test("resolves merge-base for branch comparisons", async () => {
		const repoRoot = createTempRepo();
		write(repoRoot, "src/base.ts", "export const base = true;\n");
		const baseCommit = commitAll(repoRoot, "Base commit");
		run("git", ["checkout", "-q", "-b", "feature/diff"], repoRoot);
		write(repoRoot, "src/base.ts", "export const base = false;\n");
		commitAll(repoRoot, "Feature change");
		const pi = createPi();

		await expect(getMergeBase(pi, "main", repoRoot)).resolves.toBe(baseCommit);
		const resolvedTarget = await resolveDiffTarget(pi, repoRoot, { type: "baseBranch", branch: "main" });
		expect(resolvedTarget?.baseRev).toBe(baseCommit);
	});

	test("builds uncommitted diffs with synthesized untracked file additions", async () => {
		const repoRoot = createTempRepo();
		write(repoRoot, "src/tracked.ts", "export const value = 1;\n");
		commitAll(repoRoot, "Initial commit");
		write(repoRoot, "src/tracked.ts", "export const value = 2;\n");
		write(repoRoot, "src/untracked.ts", "export const added = true;\n");

		const review = await buildReview(repoRoot, { type: "uncommitted" });
		expect(review.files.map((file) => [file.path, file.status])).toEqual([
			["src/tracked.ts", "modified"],
			["src/untracked.ts", "added"],
		]);
		const untrackedFileId = review.files.find((file) => file.path === "src/untracked.ts")?.id;
		expect(untrackedFileId).toBeTruthy();
		expect(review.filePayloads.get(untrackedFileId!)?.diffText).toContain("+++ b/src/untracked.ts");
	});

	test("resolves commit targets against their parent or the empty tree", async () => {
		const repoRoot = createTempRepo();
		write(repoRoot, "src/root.ts", "export const root = true;\n");
		const rootCommit = commitAll(repoRoot, "Root commit");
		const pi = createPi();

		const target = await resolveDiffTarget(pi, repoRoot, { type: "commit", sha: rootCommit });
		expect(target?.baseRev).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
		expect(target?.headRev).toBe(rootCommit);
	});

	test("maps rename, delete, and add statuses from commit diffs", async () => {
		const repoRoot = createTempRepo();
		write(repoRoot, "src/rename-me.ts", "export const before = true;\n");
		write(repoRoot, "src/delete-me.ts", "delete me\n");
		commitAll(repoRoot, "Initial commit");

		renameSync(path.join(repoRoot, "src/rename-me.ts"), path.join(repoRoot, "src/renamed.ts"));
		unlinkSync(path.join(repoRoot, "src/delete-me.ts"));
		write(repoRoot, "src/add-me.ts", "export const added = true;\n");
		const commitSha = commitAll(repoRoot, "Rename, delete, and add");

		const review = await buildReview(repoRoot, { type: "commit", sha: commitSha });
		expect(review.files.map((file) => [file.path, file.status])).toEqual([
			["src/add-me.ts", "added"],
			["src/delete-me.ts", "deleted"],
			["src/renamed.ts", "renamed"],
		]);
	});

	test("includes full file context for expandable hunks", async () => {
		const repoRoot = createTempRepo();
		write(repoRoot, "src/context.ts", Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n") + "\n");
		commitAll(repoRoot, "Initial commit");
		write(repoRoot, "src/context.ts", Array.from({ length: 20 }, (_, index) => (index === 9 ? "line ten" : `line ${index + 1}`)).join("\n") + "\n");

		const review = await buildReview(repoRoot, { type: "uncommitted" });
		const fileId = review.files.find((file) => file.path === "src/context.ts")?.id;
		const payload = review.filePayloads.get(fileId!);
		expect(payload?.diffText).toContain("@@ -7,7 +7,7 @@");
		expect(payload?.parsedDiff?.isPartial).toBe(false);
		expect(payload?.parsedDiff?.additionLines).toContain("line 1\n");
		expect(payload?.parsedDiff?.additionLines).toContain("line 20\n");
		expect(payload?.parsedDiff?.hunks[0]?.collapsedBefore).toBe(6);
	});

	test("preserves trailing spaces in raw patches", async () => {
		const repoRoot = createTempRepo();
		write(repoRoot, "src/space.txt", "value\n");
		commitAll(repoRoot, "Initial commit");
		write(repoRoot, "src/space.txt", "value   ");

		const review = await buildReview(repoRoot, { type: "uncommitted" });
		const fileId = review.files.find((file) => file.path === "src/space.txt")?.id;
		const payload = review.filePayloads.get(fileId!);
		expect(payload?.diffText).toContain("+value   ");
		expect(payload?.diffText).toContain("\\ No newline at end of file");
	});

	test("filters explicit binary and minified assets from review output", async () => {
		const repoRoot = createTempRepo();
		write(repoRoot, "src/keep.ts", "export const keep = 1;\n");
		commitAll(repoRoot, "Initial commit");
		write(repoRoot, "src/keep.ts", "export const keep = 2;\n");
		write(repoRoot, "public/app.min.js", "function minified(){return 1;}\n");
		write(repoRoot, "assets/image.png", Buffer.from([0, 1, 2, 3]));

		const review = await buildReview(repoRoot, { type: "uncommitted" });
		expect(review.files.map((file) => file.path)).toEqual(["src/keep.ts"]);
	});
});
