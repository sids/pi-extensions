import { describe, expect, test, vi } from "vitest";
import sessionPaths from "../index";

const { patchState } = vi.hoisted(() => ({
	patchState: {
		currentCwd: undefined as string | undefined,
		currentSessionDir: undefined as string | undefined,
		uninstall: vi.fn(),
	},
}));

vi.mock("../session-manager", () => ({
	installSessionPathEquivalence: vi.fn(() => patchState),
}));

type Handler = (event: unknown, ctx: any) => Promise<void>;

describe("session-paths extension", () => {
	test("tracks the active session and removes the patch on shutdown", async () => {
		const handlers = new Map<string, Handler>();
		const pi = {
			on(name: string, handler: Handler) {
				handlers.set(name, handler);
			},
		};

		sessionPaths(pi as any);
		await handlers.get("session_start")?.({}, {
			cwd: "/Users/alex/src/project",
			sessionManager: { getSessionDir: () => "/sessions/--Users-alex-src-project--" },
		});

		expect(patchState.currentCwd).toBe("/Users/alex/src/project");
		expect(patchState.currentSessionDir).toBe("/sessions/--Users-alex-src-project--");

		await handlers.get("session_shutdown")?.({}, {});
		expect(patchState.uninstall).toHaveBeenCalledOnce();
	});
});
