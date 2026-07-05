export type ExtensionModeContext = {
	mode?: string;
	hasUI?: boolean;
};

export function isTuiMode(ctx: ExtensionModeContext): boolean {
	if (ctx.mode !== undefined) {
		return ctx.mode === "tui";
	}

	return ctx.hasUI ?? true;
}
