import { afterEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { getAnswerSettingsPaths, loadAnswerSettings } from "../index";

const cleanupPaths: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
	if (originalAgentDir === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	}

	while (cleanupPaths.length > 0) {
		const cleanupPath = cleanupPaths.pop();
		if (cleanupPath) {
			rmSync(cleanupPath, { recursive: true, force: true });
		}
	}
});

function createCtx(cwd: string, projectTrusted: boolean) {
	return {
		cwd,
		hasUI: false,
		isProjectTrusted: () => projectTrusted,
		ui: {
			notify: () => {},
		},
	} as any;
}

describe("getAnswerSettingsPaths", () => {
	test("uses pi's configured agent dir for the global settings path", () => {
		const cwd = "/tmp/project";
		expect(getAnswerSettingsPaths(cwd)).toEqual({
			globalPath: path.join(getAgentDir(), "settings.json"),
			projectPath: path.join(cwd, CONFIG_DIR_NAME, "settings.json"),
		});
	});
});

describe("loadAnswerSettings", () => {
	test("ignores project settings when the project is not trusted", async () => {
		const baseDir = mkdtempSync(path.join(tmpdir(), "answer-settings-"));
		cleanupPaths.push(baseDir);
		process.env.PI_CODING_AGENT_DIR = path.join(baseDir, "agent");

		const cwd = path.join(baseDir, "repo");
		const { globalPath, projectPath } = getAnswerSettingsPaths(cwd);
		mkdirSync(path.dirname(globalPath), { recursive: true });
		mkdirSync(path.dirname(projectPath), { recursive: true });
		writeFileSync(globalPath, JSON.stringify({ answer: { systemPrompt: "global prompt" } }), "utf8");
		writeFileSync(projectPath, JSON.stringify({ answer: { systemPrompt: "project prompt" } }), "utf8");

		await expect(loadAnswerSettings(createCtx(cwd, true))).resolves.toMatchObject({
			systemPrompt: "project prompt",
		});
		await expect(loadAnswerSettings(createCtx(cwd, false))).resolves.toMatchObject({
			systemPrompt: "global prompt",
		});
	});
});
