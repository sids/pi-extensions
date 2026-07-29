import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { areEquivalentHomePaths, getSessionLookupTargets, mergeSessionInfos } from "./utils";

type SessionListProgress = (loaded: number, total: number) => void;

interface SessionManagerInstance {
	getCwd(): string;
	getSessionDir(): string;
}

interface SessionManagerStatics {
	list(cwd: string, sessionDir?: string, onProgress?: SessionListProgress): Promise<SessionInfo[]>;
	open(path: string, sessionDir?: string, cwdOverride?: string): SessionManagerInstance;
}

export interface PatchState {
	currentCwd?: string;
	currentSessionDir?: string;
	uninstall(): void;
}

interface PatchRegistry {
	states: WeakMap<object, PatchState>;
}

const PATCH_REGISTRY_KEY = Symbol.for("pi-session-paths.patch-registry");

function getPatchRegistry(): PatchRegistry {
	const globals = globalThis as typeof globalThis & { [PATCH_REGISTRY_KEY]?: PatchRegistry };
	globals[PATCH_REGISTRY_KEY] ??= { states: new WeakMap() };
	return globals[PATCH_REGISTRY_KEY];
}

function getOpenSessionDir(state: PatchState, sessionDir?: string): string | undefined {
	if (!state.currentCwd) {
		return sessionDir;
	}

	return getSessionLookupTargets(state.currentCwd, sessionDir ?? state.currentSessionDir)[0]?.sessionDir;
}

export function installSessionPathEquivalence(
	sessionManager: SessionManagerStatics = SessionManager,
): PatchState {
	const registry = getPatchRegistry();
	const existingState = registry.states.get(sessionManager as object);
	if (existingState) {
		return existingState;
	}

	const originalList = sessionManager.list;
	const originalOpen = sessionManager.open;
	const state: PatchState = {
		uninstall() {},
	};

	const patchedList: SessionManagerStatics["list"] = async (cwd, sessionDir, onProgress) => {
		const targets = getSessionLookupTargets(cwd, sessionDir);
		if (targets.length === 1) {
			return originalList.call(sessionManager, targets[0].cwd, targets[0].sessionDir, onProgress);
		}

		const progress = targets.map(() => ({ loaded: 0, total: 0 }));
		const sessionGroups = await Promise.all(
			targets.map((target, index) =>
				originalList.call(sessionManager, target.cwd, target.sessionDir, (loaded, total) => {
					progress[index] = { loaded, total };
					onProgress?.(
						progress.reduce((sum, item) => sum + item.loaded, 0),
						progress.reduce((sum, item) => sum + item.total, 0),
					);
				}),
			),
		);

		return mergeSessionInfos(sessionGroups);
	};

	const patchedOpen: SessionManagerStatics["open"] = (path, sessionDir, cwdOverride) => {
		if (cwdOverride !== undefined || !state.currentCwd) {
			return originalOpen.call(sessionManager, path, sessionDir, cwdOverride);
		}

		const openedSession = originalOpen.call(sessionManager, path, sessionDir);
		if (
			resolve(openedSession.getCwd()) === resolve(state.currentCwd) ||
			!areEquivalentHomePaths(openedSession.getCwd(), state.currentCwd)
		) {
			return openedSession;
		}

		return originalOpen.call(sessionManager, path, getOpenSessionDir(state, sessionDir), state.currentCwd);
	};

	sessionManager.list = patchedList;
	sessionManager.open = patchedOpen;
	state.uninstall = () => {
		if (sessionManager.list === patchedList) {
			sessionManager.list = originalList;
		}
		if (sessionManager.open === patchedOpen) {
			sessionManager.open = originalOpen;
		}
		registry.states.delete(sessionManager as object);
	};

	registry.states.set(sessionManager as object, state);
	return state;
}
