import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectAdditionalSkillPaths } from "../utils";

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (!dir) {
			continue;
		}
		rmSync(dir, { recursive: true, force: true });
	}
});

function createTempDir(prefix: string): string {
	const dir = mkdtempSync(path.join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

describe("collectAdditionalSkillPaths", () => {
	test("returns both configured paths when both directories exist", () => {
		const cwd = createTempDir("pi-skill-paths-cwd-");
		const homeDir = createTempDir("pi-skill-paths-home-");
		const projectSkills = path.resolve(cwd, ".agents", "skills");
		const userSkills = path.resolve(homeDir, ".agent", "skills");
		mkdirSync(projectSkills, { recursive: true });
		mkdirSync(userSkills, { recursive: true });

		const result = collectAdditionalSkillPaths({ cwd, homeDir });

		expect(result).toEqual([projectSkills, userSkills]);
	});

	test("returns only existing skill directories", () => {
		const cwd = createTempDir("pi-skill-paths-cwd-");
		const homeDir = createTempDir("pi-skill-paths-home-");
		const projectSkills = path.resolve(cwd, ".agents", "skills");
		mkdirSync(projectSkills, { recursive: true });

		const result = collectAdditionalSkillPaths({ cwd, homeDir });

		expect(result).toEqual([projectSkills]);
	});

	test("ignores paths that exist but are not directories", () => {
		const cwd = createTempDir("pi-skill-paths-cwd-");
		const homeDir = createTempDir("pi-skill-paths-home-");
		const projectSkills = path.resolve(cwd, ".agents", "skills");
		const userSkills = path.resolve(homeDir, ".agent", "skills");
		mkdirSync(path.dirname(projectSkills), { recursive: true });
		mkdirSync(path.dirname(userSkills), { recursive: true });
		writeFileSync(projectSkills, "not a directory", "utf8");
		writeFileSync(userSkills, "not a directory", "utf8");

		const result = collectAdditionalSkillPaths({ cwd, homeDir });

		expect(result).toEqual([]);
	});
});
