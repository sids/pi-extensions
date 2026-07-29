import { describe, expect, test } from "vitest";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { installSessionPathEquivalence } from "../session-manager";

function createSessionInfo(path: string, modified: string): SessionInfo {
	return {
		path,
		id: path,
		cwd: "/Users/alex/src/project",
		created: new Date("2026-01-01T00:00:00Z"),
		modified: new Date(modified),
		messageCount: 1,
		firstMessage: "hello",
		allMessagesText: "hello",
	};
}

describe("installSessionPathEquivalence", () => {
	test("combines sessions from both default session directories", async () => {
		const macSession = createSessionInfo("/sessions/mac.jsonl", "2026-01-02T00:00:00Z");
		const linuxSession = createSessionInfo("/sessions/linux.jsonl", "2026-01-03T00:00:00Z");

		class FakeSessionManager {
			static listCalls: Array<{ cwd: string; sessionDir?: string }> = [];

			static async list(cwd: string, sessionDir?: string, onProgress?: (loaded: number, total: number) => void) {
				this.listCalls.push({ cwd, sessionDir });
				onProgress?.(1, 1);
				return cwd.startsWith("/Users/") ? [macSession] : [linuxSession];
			}

			static open() {
				return { getCwd: () => "/tmp", getSessionDir: () => "/sessions" };
			}
		}

		installSessionPathEquivalence(FakeSessionManager as any);
		const progress: Array<[number, number]> = [];
		const sessions = await FakeSessionManager.list(
			"/Users/alex/src/project",
			"/sessions/--Users-alex-src-project--",
			(loaded, total) => progress.push([loaded, total]),
		);

		expect(FakeSessionManager.listCalls).toEqual([
			{ cwd: "/Users/alex/src/project", sessionDir: "/sessions/--Users-alex-src-project--" },
			{ cwd: "/home/alex/src/project", sessionDir: "/sessions/--home-alex-src-project--" },
		]);
		expect(sessions).toEqual([linuxSession, macSession]);
		expect(progress.at(-1)).toEqual([2, 2]);
	});

	test("opens an equivalent session in the active cwd and current default session directory", () => {
		class FakeSessionManager {
			static openCalls: Array<{ path: string; sessionDir?: string; cwdOverride?: string }> = [];

			static async list() {
				return [];
			}

			static open(path: string, sessionDir?: string, cwdOverride?: string) {
				this.openCalls.push({ path, sessionDir, cwdOverride });
				return {
					getCwd: () => cwdOverride ?? "/home/alex/src/project",
					getSessionDir: () => sessionDir ?? "/sessions/--home-alex-src-project--",
				};
			}
		}

		const state = installSessionPathEquivalence(FakeSessionManager as any);
		state.currentCwd = "/Users/alex/src/project";
		state.currentSessionDir = "/sessions/--Users-alex-src-project--";

		const session = FakeSessionManager.open("/sessions/linux.jsonl");

		expect(FakeSessionManager.openCalls).toEqual([
			{ path: "/sessions/linux.jsonl", sessionDir: undefined, cwdOverride: undefined },
			{
				path: "/sessions/linux.jsonl",
				sessionDir: "/sessions/--Users-alex-src-project--",
				cwdOverride: "/Users/alex/src/project",
			},
		]);
		expect(session.getCwd()).toBe("/Users/alex/src/project");
	});

	test("does not override unrelated session cwd paths", () => {
		class FakeSessionManager {
			static openCalls = 0;

			static async list() {
				return [];
			}

			static open(_path: string, _sessionDir?: string, _cwdOverride?: string) {
				this.openCalls += 1;
				return { getCwd: () => "/work/other", getSessionDir: () => "/sessions" };
			}
		}

		const state = installSessionPathEquivalence(FakeSessionManager as any);
		state.currentCwd = "/Users/alex/src/project";
		state.currentSessionDir = "/sessions/--Users-alex-src-project--";

		FakeSessionManager.open("/sessions/other.jsonl");

		expect(FakeSessionManager.openCalls).toBe(1);
	});
});
