export interface SystemPromptDiagnosticContext {
	getSystemPromptOptions?: () => {
		contextFiles?: Array<{ path: string; content: string }>;
		skills?: Array<{ name: string }>;
	};
}

/**
 * Produces a short summary of loaded context files and skills.
 * Designed for use in TUI notifications when commands activate a mode.
 *
 * Returns an empty string when no context files or skills are loaded.
 */
export function summarizeLoadedContext(ctx: SystemPromptDiagnosticContext): string {
	let options: ReturnType<NonNullable<SystemPromptDiagnosticContext["getSystemPromptOptions"]>>;
	try {
		options = ctx.getSystemPromptOptions?.() ?? {};
	} catch {
		return "";
	}

	const lines: string[] = [];

	const contextPaths = options.contextFiles?.map((f) => f.path) ?? [];
	if (contextPaths.length > 0) {
		lines.push(
			contextPaths.length === 1 ? "1 context file" : `${contextPaths.length} context files`,
		);
	}

	const skillNames = options.skills?.map((s) => s.name) ?? [];
	if (skillNames.length > 0) {
		const label = skillNames.length === 1 ? "1 skill" : `${skillNames.length} skills`;
		const preview = skillNames.slice(0, 3).join(", ");
		const suffix = skillNames.length > 3 ? `, +${skillNames.length - 3} more` : "";
		lines.push(`${label}: ${preview}${suffix}`);
	}

	return lines.join(" • ");
}
