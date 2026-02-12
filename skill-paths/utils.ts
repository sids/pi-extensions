import { existsSync, statSync } from "node:fs";
import path from "node:path";

type AdditionalSkillPathOptions = {
	cwd: string;
	homeDir: string;
};

function isDirectory(pathToCheck: string): boolean {
	if (!existsSync(pathToCheck)) {
		return false;
	}

	try {
		return statSync(pathToCheck).isDirectory();
	} catch {
		return false;
	}
}

export function collectAdditionalSkillPaths(options: AdditionalSkillPathOptions): string[] {
	const candidates = [
		path.resolve(options.cwd, ".agents", "skills"),
		path.resolve(options.homeDir, ".agent", "skills"),
	];

	const unique = new Set<string>();
	const existingDirectories: string[] = [];
	for (const candidate of candidates) {
		if (unique.has(candidate)) {
			continue;
		}
		unique.add(candidate);

		if (!isDirectory(candidate)) {
			continue;
		}
		existingDirectories.push(candidate);
	}

	return existingDirectories;
}
