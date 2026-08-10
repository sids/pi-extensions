import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
	getCurrentBranch,
	getDefaultBranchInfo,
	getLocalBranches,
	getRecentCommits,
	hasWorkingTreeChanges,
	isGitRepository,
} from "@siddr/pi-shared-qna/diff-target";

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		rmSync(tempDirs.pop()!, { recursive: true, force: true });
	}
});

function run(command: string, args: string[], cwd: string) {
	const result = spawnSync(command, args, { cwd, encoding: "utf8" });
	if ((result.status ?? 1) !== 0) {
		throw new Error(`Command failed: ${command} ${args.join(" ")}\n${result.stderr}`);
	}
	return result.stdout;
}

function createRepo() {
	const repo = mkdtempSync(path.join(tmpdir(), "pi-diff-review-"));
	tempDirs.push(repo);
	run("git", ["init", "-q", "-b", "main"], repo);
	run("git", ["config", "user.email", "sid@example.com"], repo);
	run("git", ["config", "user.name", "Sid"], repo);
	writeFileSync(path.join(repo, "README.md"), "hello\n");
	run("git", ["add", "."], repo);
	run("git", ["commit", "-q", "-m", "Initial commit"], repo);
	return repo;
}

function createPi() {
	return {
		exec: async (command: string, args: string[], options?: { cwd?: string }) => {
			const result = spawnSync(command, args, { cwd: options?.cwd, encoding: "utf8" });
			return {
				stdout: result.stdout,
				stderr: result.stderr,
				code: result.status ?? 1,
				killed: false,
			};
		},
	} as any;
}

describe("git target helpers", () => {
	test("reads repository state used by the target picker", async () => {
		const repo = createRepo();
		const pi = createPi();

		await expect(isGitRepository(pi, repo)).resolves.toBe(true);
		await expect(getCurrentBranch(pi, repo)).resolves.toBe("main");
		await expect(getLocalBranches(pi, repo)).resolves.toEqual(["main"]);
		await expect(getRecentCommits(pi, 1, repo)).resolves.toMatchObject([
			{ title: "Initial commit" },
		]);
		await expect(hasWorkingTreeChanges(pi, repo)).resolves.toBe(false);

		writeFileSync(path.join(repo, "README.md"), "changed\n");
		await expect(hasWorkingTreeChanges(pi, repo)).resolves.toBe(true);
	});

	test("falls back to main when no remote default is configured", async () => {
		const repo = createRepo();
		await expect(getDefaultBranchInfo(createPi(), repo)).resolves.toEqual({
			branch: "main",
			isReliable: false,
		});
	});
});
