import type { ExtensionUIContext } from "@mariozechner/pi-coding-agent";

export type SessionEditorComponentFactory = Parameters<ExtensionUIContext["setEditorComponent"]>[0];

type SessionEditorComponentContext = {
	cwd?: string;
	sessionManager?: {
		getSessionFile?: () => string | undefined;
		getSessionId?: () => string | undefined;
	};
};

const rememberedSessionEditorComponents = new Map<string, SessionEditorComponentFactory>();

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
	rememberedSessionEditorComponents.set(buildSessionEditorComponentKey(ctx), factory);
}

export function getRememberedSessionEditorComponentFactory(
	ctx: SessionEditorComponentContext,
): SessionEditorComponentFactory {
	return rememberedSessionEditorComponents.get(buildSessionEditorComponentKey(ctx));
}

export function setRememberedSessionEditorComponent(
	ctx: SessionEditorComponentContext & { ui: Pick<ExtensionUIContext, "setEditorComponent"> },
	factory: SessionEditorComponentFactory,
): void {
	rememberSessionEditorComponentFactory(ctx, factory);
	ctx.ui.setEditorComponent(factory);
}

export function clearRememberedSessionEditorComponentFactory(ctx: SessionEditorComponentContext): void {
	rememberedSessionEditorComponents.delete(buildSessionEditorComponentKey(ctx));
}
