import { describe, expect, test } from "bun:test";
import type { EditorTheme, TUI } from "@mariozechner/pi-tui";
import type { KeybindingsManager } from "@mariozechner/pi-coding-agent";

type SessionEditorModule = typeof import("../session-editor-component");

type SessionEditorFactory = (
	tui: TUI,
	theme: EditorTheme,
	keybindings: KeybindingsManager,
) => unknown;

function createContext(sessionFile: string) {
	let installedFactory: SessionEditorFactory | undefined;
	return {
		ctx: {
			sessionManager: {
				getSessionFile: () => sessionFile,
			},
			ui: {
				setEditorComponent: (factory: SessionEditorFactory | undefined) => {
					installedFactory = factory;
				},
			},
		},
		getInstalledFactory: () => installedFactory,
	};
}

async function importFreshModule(instance: string): Promise<SessionEditorModule> {
	return import(new URL(`../session-editor-component.ts?instance=${instance}`, import.meta.url).href);
}

describe("session-editor-component shared store", () => {
	test("shares remembered factories across separate module instances", async () => {
		const moduleA = await importFreshModule("a");
		const moduleB = await importFreshModule("b");
		const sessionFile = `/tmp/shared-session-editor-${Date.now()}.json`;
		const { ctx, getInstalledFactory } = createContext(sessionFile);
		const factory = (() => null) as SessionEditorFactory;

		try {
			moduleA.setRememberedSessionEditorComponent(ctx as any, factory);

			expect(getInstalledFactory()).toBe(factory);
			expect(moduleB.getRememberedSessionEditorComponentFactory(ctx as any)).toBe(factory);

			moduleB.clearRememberedSessionEditorComponentFactory(ctx as any);
			expect(moduleA.getRememberedSessionEditorComponentFactory(ctx as any)).toBeUndefined();
		} finally {
			moduleA.clearRememberedSessionEditorComponentFactory(ctx as any);
			moduleB.clearRememberedSessionEditorComponentFactory(ctx as any);
		}
	});
});
