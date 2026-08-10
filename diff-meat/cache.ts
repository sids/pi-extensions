import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { ReadingDiff } from "./types";

const MAX_CACHE_ENTRIES = 100;

function cacheDirectory(env: NodeJS.ProcessEnv = process.env): string {
	const root = env.XDG_CACHE_HOME?.trim() || path.join(homedir(), ".cache");
	return path.join(root, "pi-diff-meat");
}

export function buildCacheKey(parts: unknown[]): string {
	return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export async function readCachedReadingDiff(key: string, env?: NodeJS.ProcessEnv): Promise<ReadingDiff | null> {
	try {
		const result = JSON.parse(await readFile(path.join(cacheDirectory(env), `${key}.json`), "utf8")) as ReadingDiff;
		if (!result
			|| typeof result.rawPatch !== "string"
			|| typeof result.summary !== "string"
			|| !Number.isInteger(result.keptSections)
			|| !Number.isInteger(result.totalSections)
			|| !result.usage
			|| ![result.usage.input, result.usage.output, result.usage.cacheRead, result.usage.cacheWrite].every(Number.isFinite)) {
			return null;
		}
		return result;
	} catch {
		return null;
	}
}

async function trimCache(directory: string): Promise<void> {
	try {
		const entries = (await readdir(directory))
			.filter((entry) => /^[a-f0-9]{64}\.json$/u.test(entry));
		if (entries.length <= MAX_CACHE_ENTRIES) return;
		const dated = await Promise.all(entries.map(async (entry) => ({
			entry,
			mtime: (await stat(path.join(directory, entry))).mtimeMs,
		})));
		dated.sort((left, right) => right.mtime - left.mtime);
		await Promise.all(dated.slice(MAX_CACHE_ENTRIES).map(({ entry }) => unlink(path.join(directory, entry))));
	} catch {
		// Cache cleanup is best-effort.
	}
}

export async function writeCachedReadingDiff(
	key: string,
	result: ReadingDiff,
	env?: NodeJS.ProcessEnv,
): Promise<void> {
	const directory = cacheDirectory(env);
	try {
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const target = path.join(directory, `${key}.json`);
		const temporary = path.join(directory, `.${key}.${process.pid}.tmp`);
		await writeFile(temporary, JSON.stringify(result), { mode: 0o600 });
		await rename(temporary, target);
		void trimCache(directory);
	} catch {
		// A cache failure must not fail a review.
	}
}
