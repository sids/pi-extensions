import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildUnbornRepoPatch } from "../unborn-review";

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

describe("unborn repository review", () => {
	test("loads the Plannotator server seams used for the static initial review", async () => {
		const [serverModule, browserRuntime, browserModule] = await Promise.all([
			import("@plannotator/pi-extension/server.ts"),
			import("@plannotator/pi-extension/plannotator-browser-runtime.ts"),
			import("@plannotator/pi-extension/plannotator-browser.ts"),
		]);
		expect(serverModule.startReviewServer).toBeTypeOf("function");
		expect(browserRuntime.getReviewBrowserHtml).toBeTypeOf("function");
		expect(browserModule.startBrowserDecisionSession).toBeTypeOf("function");
	});

	test("includes staged and untracked files using their current contents", async () => {
		const repo = mkdtempSync(path.join(tmpdir(), "pi-diff-review-unborn-"));
		tempDirs.push(repo);
		run("git", ["init", "-q", "-b", "main"], repo);
		writeFileSync(path.join(repo, "staged.txt"), "staged version\n");
		run("git", ["add", "staged.txt"], repo);
		writeFileSync(path.join(repo, "staged.txt"), "working version\n");
		writeFileSync(path.join(repo, "untracked.txt"), "untracked\n");

		const patch = await buildUnbornRepoPatch(createPi(), repo);

		expect(patch).toContain("diff --git a/staged.txt b/staged.txt");
		expect(patch).toContain("+working version");
		expect(patch).toContain("diff --git a/untracked.txt b/untracked.txt");
		expect(patch).toContain("+untracked");
	});
});
