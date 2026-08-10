import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { buildCommitContext } from "../context";
import { prepareDiff } from "../diff";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function git(cwd: string, args: string[]): Promise<string> {
	return (await execFileAsync("git", args, { cwd, encoding: "utf8" })).stdout.trim();
}

function createPi() {
	return {
		async exec(command: string, args: string[], options?: { cwd?: string }) {
			try {
				const result = await execFileAsync(command, args, { cwd: options?.cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
				return { code: 0, stdout: result.stdout, stderr: result.stderr };
			} catch (error: any) {
				return { code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? error.message };
			}
		},
	} as any;
}

async function createRepository(): Promise<{ directory: string; featureSha: string }> {
	const directory = await mkdtemp(path.join(tmpdir(), "diff-meat-git-"));
	temporaryDirectories.push(directory);
	await git(directory, ["init", "-b", "main"]);
	await git(directory, ["config", "user.name", "Diff Meat Tests"]);
	await git(directory, ["config", "user.email", "diff-meat@example.com"]);
	await writeFile(path.join(directory, "app.ts"), "export const value = 1;\n");
	await git(directory, ["add", "app.ts"]);
	await git(directory, ["commit", "-m", "base"]);
	await git(directory, ["switch", "-c", "feature"]);
	await writeFile(path.join(directory, "app.ts"), "export const value = 2;\n");
	await git(directory, ["add", "app.ts"]);
	await git(directory, ["commit", "-m", "feature change"]);
	return { directory, featureSha: await git(directory, ["rev-parse", "HEAD"]) };
}

describe("git diff preparation", () => {
	test("includes tracked and untracked uncommitted files", async () => {
		const { directory } = await createRepository();
		await writeFile(path.join(directory, "app.ts"), "export const value = 3;\n");
		await writeFile(path.join(directory, "new.ts"), "export const added = true;\n");

		const prepared = await prepareDiff(createPi(), directory, { type: "uncommitted" });

		expect(prepared.rawPatch).toContain("app.ts");
		expect(prepared.rawPatch).toContain("new.ts");
		expect(prepared.rawPatch).toContain("+export const added = true;");
		expect(prepared.repoRoot).toBe(directory);
	});

	test("supports branch and commit targets", async () => {
		const { directory, featureSha } = await createRepository();

		const pi = createPi();
		const branch = await prepareDiff(pi, directory, { type: "baseBranch", branch: "main" });
		const commit = await prepareDiff(pi, directory, { type: "commit", sha: featureSha });
		const branchContext = await buildCommitContext(pi, directory, { type: "baseBranch", branch: "main" });
		const commitContext = await buildCommitContext(pi, directory, { type: "commit", sha: featureSha });

		expect(branch.rawPatch).toContain("+export const value = 2;");
		expect(branch.diffType).toBe("merge-base");
		expect(commit.rawPatch).toContain("+export const value = 2;");
		expect(commit.diffType).toBe(`commit:${featureSha}`);
		expect(branchContext).toContain("feature change");
		expect(branchContext).not.toContain("base");
		expect(commitContext).toContain("feature change");
	});

	test("supports unborn repositories", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "diff-meat-unborn-"));
		temporaryDirectories.push(directory);
		await git(directory, ["init", "-b", "main"]);
		await writeFile(path.join(directory, "first.ts"), "export const first = true;\n");

		const prepared = await prepareDiff(createPi(), directory, { type: "uncommitted" });

		expect(prepared.rawPatch).toContain("new file mode");
		expect(prepared.rawPatch).toContain("+export const first = true;");
	});
});
