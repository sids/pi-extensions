import { basename, dirname, join, resolve } from "node:path";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";

export interface SessionLookupTarget {
	cwd: string;
	sessionDir?: string;
}

export function getEquivalentHomePath(inputPath: string): string | undefined {
	const normalizedPath = resolve(inputPath);
	const match = normalizedPath.match(/^\/(Users|home)\/([^/]+)(\/.*)?$/u);
	if (!match) {
		return undefined;
	}

	const [, homeDirectory, username, suffix = ""] = match;
	const equivalentHomeDirectory = homeDirectory === "Users" ? "home" : "Users";
	return `/${equivalentHomeDirectory}/${username}${suffix}`;
}

export function areEquivalentHomePaths(firstPath: string, secondPath: string): boolean {
	const normalizedFirstPath = resolve(firstPath);
	const normalizedSecondPath = resolve(secondPath);
	return (
		normalizedFirstPath === normalizedSecondPath || getEquivalentHomePath(normalizedFirstPath) === normalizedSecondPath
	);
}

export function encodeSessionDirectoryName(cwd: string): string {
	const normalizedCwd = resolve(cwd);
	return `--${normalizedCwd.replace(/^[/\\]/u, "").replace(/[/\\:]/gu, "-")}--`;
}

export function getSessionLookupTargets(cwd: string, sessionDir?: string): SessionLookupTarget[] {
	const normalizedCwd = resolve(cwd);
	const equivalentCwd = getEquivalentHomePath(normalizedCwd);
	if (!equivalentCwd) {
		return [{ cwd: normalizedCwd, sessionDir }];
	}

	if (sessionDir === undefined) {
		return [
			{ cwd: normalizedCwd },
			{ cwd: equivalentCwd },
		];
	}

	const normalizedSessionDir = resolve(sessionDir);
	const sessionDirectoryName = basename(normalizedSessionDir);
	const currentDirectoryName = encodeSessionDirectoryName(normalizedCwd);
	const equivalentDirectoryName = encodeSessionDirectoryName(equivalentCwd);

	if (sessionDirectoryName === currentDirectoryName || sessionDirectoryName === equivalentDirectoryName) {
		const sessionsRoot = dirname(normalizedSessionDir);
		return [
			{ cwd: normalizedCwd, sessionDir: join(sessionsRoot, currentDirectoryName) },
			{ cwd: equivalentCwd, sessionDir: join(sessionsRoot, equivalentDirectoryName) },
		];
	}

	return [
		{ cwd: normalizedCwd, sessionDir: normalizedSessionDir },
		{ cwd: equivalentCwd, sessionDir: normalizedSessionDir },
	];
}

export function mergeSessionInfos(sessionGroups: SessionInfo[][]): SessionInfo[] {
	const sessionsByPath = new Map<string, SessionInfo>();
	for (const sessions of sessionGroups) {
		for (const session of sessions) {
			sessionsByPath.set(resolve(session.path), session);
		}
	}

	return [...sessionsByPath.values()].sort((first, second) => second.modified.getTime() - first.modified.getTime());
}
