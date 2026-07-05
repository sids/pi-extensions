export type ProjectTrustContext = {
	isProjectTrusted?: () => boolean;
};

export function isProjectTrusted(ctx: ProjectTrustContext): boolean {
	return ctx.isProjectTrusted?.() ?? true;
}
