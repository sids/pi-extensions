import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadPlanModePrompt } from "../prompts";

const tempDirs: string[] = [];

afterEach(async () => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (!dir) {
			continue;
		}
		await rm(dir, { recursive: true, force: true });
	}
});

async function createPromptPaths() {
	const tempDir = await mkdtemp(path.join(os.tmpdir(), "plan-md-prompts-"));
	tempDirs.push(tempDir);

	const agentDirPath = path.join(tempDir, "agent");
	await mkdir(agentDirPath, { recursive: true });

	const bundledPromptPath = path.join(tempDir, "bundled", "PLAN.prompt.md");
	await mkdir(path.dirname(bundledPromptPath), { recursive: true });

	return {
		agentDirPath,
		bundledPromptPath,
	};
}

describe("loadPlanModePrompt", () => {
	test("loads bundled prompt when override is missing", async () => {
		const paths = await createPromptPaths();
		await writeFile(paths.bundledPromptPath, "bundled prompt\n", "utf8");

		const prompt = await loadPlanModePrompt(paths);
		expect(prompt).toBe("bundled prompt");
	});

	test("prefers override prompt when present", async () => {
		const paths = await createPromptPaths();
		await writeFile(paths.bundledPromptPath, "bundled prompt\n", "utf8");
		await writeFile(path.join(paths.agentDirPath, "PLAN.prompt.md"), "override prompt\n", "utf8");

		const prompt = await loadPlanModePrompt(paths);
		expect(prompt).toBe("override prompt");
	});

	test("falls back to bundled prompt when override is blank", async () => {
		const paths = await createPromptPaths();
		await writeFile(paths.bundledPromptPath, "bundled prompt\n", "utf8");
		await writeFile(path.join(paths.agentDirPath, "PLAN.prompt.md"), "  \n\t\n", "utf8");

		const prompt = await loadPlanModePrompt(paths);
		expect(prompt).toBe("bundled prompt");
	});
});
