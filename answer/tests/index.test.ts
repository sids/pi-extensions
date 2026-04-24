import { describe, expect, test } from "bun:test";
import path from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { getAnswerSettingsPaths } from "../index";

describe("getAnswerSettingsPaths", () => {
	test("uses pi's configured agent dir for the global settings path", () => {
		const cwd = "/tmp/project";
		expect(getAnswerSettingsPaths(cwd)).toEqual({
			globalPath: path.join(getAgentDir(), "settings.json"),
			projectPath: path.join(cwd, ".pi", "settings.json"),
		});
	});
});
