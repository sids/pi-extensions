import type { ExtensionUIContext } from "@mariozechner/pi-coding-agent";

export type SessionEditorComponentFactory = Parameters<ExtensionUIContext["setEditorComponent"]>[0];

type SessionEditorComponentContext = {
	cwd?: string;
	sessionManager?: {
		getSessionFile?: () => string | undefined;
		getSessionId?: () => string | undefined;
	};
};

const SESSION_EDITOR_COMPONENT_STORE_KEY = Symbol.for("@siddr/pi-shared-qna/session-editor-component/store");

type SessionEditorComponentStore = {
	rememberedSessionEditorComponents: Map<string, SessionEditorComponentFactory>;
};

function getSessionEditorComponentStore(): SessionEditorComponentStore {
	const globalState = globalThis as typeof globalThis & {
		[SESSION_EDITOR_COMPONENT_STORE_KEY]?: SessionEditorComponentStore;
	};
	if (!globalState[SESSION_EDITOR_COMPONENT_STORE_KEY]) {
		globalState[SESSION_EDITOR_COMPONENT_STORE_KEY] = {
			rememberedSessionEditorComponents: new Map<string, SessionEditorComponentFactory>(),
		};
	}
	return globalState[SESSION_EDITOR_COMPONENT_STORE_KEY]!;
}

export function buildSessionEditorComponentKey(ctx: SessionEditorComponentContext): string {
	const sessionFile = ctx.sessionManager?.getSessionFile?.();
	if (sessionFile) {
		return `session:${sessionFile}`;
	}
	const sessionId = ctx.sessionManager?.getSessionId?.();
	if (sessionId) {
		return `ephemeral:${sessionId}`;
	}
	return `cwd:${ctx.cwd ?? process.cwd()}`;
}

export function rememberSessionEditorComponentFactory(
	ctx: SessionEditorComponentContext,
	factory: SessionEditorComponentFactory,
): void {
	getSessionEditorComponentStore().rememberedSessionEditorComponents.set(buildSessionEditorComponentKey(ctx), factory);
}

export function getRememberedSessionEditorComponentFactory(
	ctx: SessionEditorComponentContext,
): SessionEditorComponentFactory {
	return getSessionEditorComponentStore().rememberedSessionEditorComponents.get(buildSessionEditorComponentKey(ctx));
}

export function setRememberedSessionEditorComponent(
	ctx: SessionEditorComponentContext & { ui: Pick<ExtensionUIContext, "setEditorComponent"> },
	factory: SessionEditorComponentFactory,
): void {
	rememberSessionEditorComponentFactory(ctx, factory);
	ctx.ui.setEditorComponent(factory);
}

export function composeRememberedSessionEditorComponent(
	ctx: SessionEditorComponentContext & { ui: Pick<ExtensionUIContext, "setEditorComponent"> },
	buildFactory: (previousFactory: SessionEditorComponentFactory | undefined) => SessionEditorComponentFactory,
): void {
	const previousFactory = getRememberedSessionEditorComponentFactory(ctx);
	setRememberedSessionEditorComponent(ctx, buildFactory(previousFactory));
}

export function clearRememberedSessionEditorComponentFactory(ctx: SessionEditorComponentContext): void {
	getSessionEditorComponentStore().rememberedSessionEditorComponents.delete(buildSessionEditorComponentKey(ctx));
}
