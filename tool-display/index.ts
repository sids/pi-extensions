import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	getLanguageFromPath,
	highlightCode,
	keyHint,
	renderDiff,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import {
	buildPreview,
	countFindResults,
	countGrepMatches,
	countLines,
	countLsEntries,
	countReadLines,
	extractTextContent,
	formatDisplayPath,
	getDiffStats,
	hasImageContent,
	splitTrailingNoticeBlock,
} from "./utils";

type BuiltInTools = ReturnType<typeof createBuiltInTools>;

const toolCache = new Map<string, BuiltInTools>();

function createBuiltInTools(cwd: string) {
	return {
		read: createReadTool(cwd),
		write: createWriteTool(cwd),
		edit: createEditTool(cwd),
		bash: createBashTool(cwd),
		grep: createGrepTool(cwd),
		find: createFindTool(cwd),
		ls: createLsTool(cwd),
	};
}

function getBuiltInTools(cwd: string): BuiltInTools {
	let tools = toolCache.get(cwd);
	if (!tools) {
		tools = createBuiltInTools(cwd);
		toolCache.set(cwd, tools);
	}
	return tools;
}

const toolDisplayDetailsKey = "toolDisplay";

function getTextComponent(text: string) {
	return new Text(text, 0, 0);
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
	return count === 1 ? singular : plural;
}

function formatLineCount(count: number): string {
	return `${count} ${pluralize(count, "line")}`;
}

function formatRemainingLinesHint(remainingLines: number, theme: any): string {
	return `${theme.fg("muted", `... (${remainingLines} more ${pluralize(remainingLines, "line")}, `)}${keyHint("expandTools", "to expand")}${theme.fg("muted", ")")}`;
}

function formatExpandHint(): string {
	return `(${keyHint("expandTools", "to expand")})`;
}

function formatWarning(notice: string | undefined, theme: any): string | undefined {
	return notice ? theme.fg("warning", notice) : undefined;
}

function joinSections(...parts: Array<string | undefined>): string {
	return parts.filter((part) => part && part.length > 0).join("\n");
}

function renderBalanceBar(bar: ReturnType<typeof getDiffStats>["bar"], theme: any): string {
	const segments: string[] = [];
	if (bar.added > 0) {
		segments.push(theme.fg("success", "█".repeat(bar.added)));
	}
	if (bar.removed > 0) {
		segments.push(theme.fg("error", "█".repeat(bar.removed)));
	}
	if (bar.neutral > 0) {
		segments.push(theme.fg("muted", "·".repeat(bar.neutral)));
	}
	return segments.join("");
}

function renderRawText(text: string, theme: any, isError: boolean) {
	const output = text.length > 0 ? text : isError ? "Error" : "(no output)";
	return getTextComponent(isError ? theme.fg("error", output) : output);
}

function withToolDisplayDetails<T extends { details?: unknown }>(
	result: T,
	toolDisplay: { path?: string; content?: string },
): T {
	const existingDetails =
		result.details && typeof result.details === "object" && !Array.isArray(result.details) ? result.details : {};

	return {
		...result,
		details: {
			...existingDetails,
			[toolDisplayDetailsKey]: toolDisplay,
		},
	};
}

function getToolDisplayDetails(result: { details?: unknown }): { path?: string; content?: string } | undefined {
	const details = result.details;
	if (!details || typeof details !== "object" || Array.isArray(details)) {
		return undefined;
	}

	const toolDisplay = (details as Record<string, unknown>)[toolDisplayDetailsKey];
	if (!toolDisplay || typeof toolDisplay !== "object" || Array.isArray(toolDisplay)) {
		return undefined;
	}

	return toolDisplay as { path?: string; content?: string };
}

function isLikelyErrorText(text: string): boolean {
	if (text.length === 0) {
		return false;
	}

	return (
		text.startsWith("Error") ||
		text.startsWith("Operation aborted") ||
		text.startsWith("Path not found:") ||
		text.startsWith("Not a directory:") ||
		text.startsWith("Cannot read directory:") ||
		text.startsWith("File not found:") ||
		text.startsWith("Offset ") ||
		text.startsWith("Working directory does not exist:") ||
		text.startsWith("Failed to run ") ||
		text.startsWith("fd is not available") ||
		text.startsWith("ripgrep (rg) is not available") ||
		text.endsWith("Command aborted") ||
		/Command timed out after \d+ seconds\s*$/.test(text) ||
		/Command exited with code \d+\s*$/.test(text)
	);
}

export default function (pi: ExtensionAPI) {
	const referenceTools = getBuiltInTools(process.cwd());

	pi.registerTool({
		name: "read",
		label: "read",
		description: referenceTools.read.description,
		parameters: referenceTools.read.parameters,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const result = await getBuiltInTools(ctx.cwd).read.execute(toolCallId, params, signal, onUpdate);
			return withToolDisplayDetails(result, { path: params.path });
		},
		renderCall(args, theme) {
			const displayPath = formatDisplayPath(args.path ?? "", {
				offset: typeof args.offset === "number" ? args.offset : undefined,
				limit: typeof args.limit === "number" ? args.limit : undefined,
			});
			const text = `${theme.fg("toolTitle", theme.bold("read"))} ${theme.fg("accent", displayPath)}`;
			return getTextComponent(text);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) {
				return getTextComponent(theme.fg("muted", "↳ loading..."));
			}

			const text = extractTextContent(result);
			if (isLikelyErrorText(text)) {
				return renderRawText(text, theme, true);
			}

			if (hasImageContent(result)) {
				return renderRawText(text || "Read image file", theme, false);
			}

			const { body, notice } = splitTrailingNoticeBlock(text);
			if (!expanded) {
				const lineCount = countReadLines(text);
				const summary = `${theme.fg("muted", `↳ loaded ${formatLineCount(lineCount)}`)} ${formatExpandHint()}`;
				return getTextComponent(joinSections(summary, formatWarning(notice, theme)));
			}

			const path = getToolDisplayDetails(result)?.path ?? "";
			const language = getLanguageFromPath(path);
			const highlighted = body.length > 0 ? highlightCode(body, language).join("\n") : theme.fg("muted", "(empty file)");
			return getTextComponent(joinSections(highlighted, formatWarning(notice, theme)));
		},
	});

	pi.registerTool({
		name: "write",
		label: "write",
		description: referenceTools.write.description,
		parameters: referenceTools.write.parameters,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const result = await getBuiltInTools(ctx.cwd).write.execute(toolCallId, params, signal, onUpdate);
			return withToolDisplayDetails(result, { content: params.content });
		},
		renderCall(args, theme) {
			const displayPath = formatDisplayPath(args.path ?? "");
			const lineCount = countLines(args.content ?? "");
			const text = `${theme.fg("toolTitle", theme.bold("write"))} ${theme.fg("accent", displayPath)} ${theme.fg("muted", `(${formatLineCount(lineCount)})`)}`;
			return getTextComponent(text);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) {
				return getTextComponent(theme.fg("muted", "Writing..."));
			}

			const text = extractTextContent(result);
			if (isLikelyErrorText(text)) {
				return renderRawText(text, theme, true);
			}

			const content = getToolDisplayDetails(result)?.content ?? "";
			const preview = buildPreview(content);
			const body = expanded ? content : preview.previewText;
			const display = body.length > 0 ? body : theme.fg("muted", "(empty file)");
			const hint = !expanded && preview.hasMore ? formatRemainingLinesHint(preview.remainingLines, theme) : undefined;
			return getTextComponent(joinSections(display, hint));
		},
	});

	pi.registerTool({
		name: "bash",
		label: "bash",
		description: referenceTools.bash.description,
		parameters: referenceTools.bash.parameters,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).bash.execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme) {
			let text = `${theme.fg("toolTitle", theme.bold("$"))} ${theme.fg("accent", args.command ?? "")}`;
			if (typeof args.timeout === "number") {
				text += ` ${theme.fg("muted", `(timeout ${args.timeout}s)`)}`;
			}
			return getTextComponent(text);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			const text = extractTextContent(result);
			if (isLikelyErrorText(text)) {
				return renderRawText(text, theme, true);
			}

			const { body, notice } = splitTrailingNoticeBlock(text);
			const preview = buildPreview(body.length > 0 ? body : text);
			const display = expanded
				? body.length > 0 || notice ? body || theme.fg("muted", "(no output)") : text || theme.fg("muted", "(no output)")
				: preview.previewText || theme.fg("muted", isPartial ? "Running..." : "(no output)");
			const hint = !expanded && preview.hasMore ? formatRemainingLinesHint(preview.remainingLines, theme) : undefined;
			return getTextComponent(joinSections(display, hint, formatWarning(notice, theme)));
		},
	});

	pi.registerTool({
		name: "edit",
		label: "edit",
		description: referenceTools.edit.description,
		parameters: referenceTools.edit.parameters,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).edit.execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme) {
			const displayPath = formatDisplayPath(args.path ?? "");
			const text = `${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", displayPath)}`;
			return getTextComponent(text);
		},
		renderResult(result, { isPartial }, theme) {
			if (isPartial) {
				return getTextComponent(theme.fg("muted", "Editing..."));
			}

			const text = extractTextContent(result);
			if (isLikelyErrorText(text)) {
				return renderRawText(text, theme, true);
			}

			const diff = typeof result.details?.diff === "string" ? result.details.diff : "";
			if (!diff) {
				return getTextComponent(theme.fg("success", "Applied"));
			}

			const stats = getDiffStats(diff);
			let summary = theme.fg("toolTitle", theme.bold("diff"));
			summary += theme.fg("muted", " • ");
			summary += theme.fg("success", `+${stats.additions}`);
			summary += theme.fg("muted", " • ");
			summary += theme.fg("error", `-${stats.removals}`);
			summary += theme.fg("muted", ` • ${stats.hunks} ${pluralize(stats.hunks, "hunk")} • ${stats.files} file • ${stats.format}`);
			summary += ` ${renderBalanceBar(stats.bar, theme)}`;

			return getTextComponent(`${summary}\n${renderDiff(diff)}`);
		},
	});

	pi.registerTool({
		name: "grep",
		label: "grep",
		description: referenceTools.grep.description,
		parameters: referenceTools.grep.parameters,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).grep.execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme) {
			let text = `${theme.fg("toolTitle", theme.bold("grep"))} ${theme.fg("accent", args.literal ? JSON.stringify(args.pattern ?? "") : `/${args.pattern ?? ""}/`)}`;
			text += theme.fg("muted", ` in ${formatDisplayPath(args.path ?? ".")}`);
			if (args.glob) {
				text += ` ${theme.fg("dim", `(${args.glob})`)}`;
			}
			return getTextComponent(text);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) {
				return getTextComponent(theme.fg("muted", "Searching..."));
			}

			const text = extractTextContent(result);
			if (isLikelyErrorText(text)) {
				return renderRawText(text, theme, true);
			}

			const { body, notice } = splitTrailingNoticeBlock(text);
			if (expanded) {
				return getTextComponent(joinSections(body || text || theme.fg("muted", "(no matches)"), formatWarning(notice, theme)));
			}

			const count = countGrepMatches(text);
			const summary = `${theme.fg("muted", `↳ ${count} ${pluralize(count, "match")}`)} ${formatExpandHint()}`;
			return getTextComponent(joinSections(summary, formatWarning(notice, theme)));
		},
	});

	pi.registerTool({
		name: "find",
		label: "find",
		description: referenceTools.find.description,
		parameters: referenceTools.find.parameters,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).find.execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme) {
			let text = `${theme.fg("toolTitle", theme.bold("find"))} ${theme.fg("accent", args.pattern ?? "")}`;
			text += theme.fg("muted", ` in ${formatDisplayPath(args.path ?? ".")}`);
			if (typeof args.limit === "number") {
				text += ` ${theme.fg("dim", `(limit ${args.limit})`)}`;
			}
			return getTextComponent(text);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) {
				return getTextComponent(theme.fg("muted", "Searching..."));
			}

			const text = extractTextContent(result);
			if (isLikelyErrorText(text)) {
				return renderRawText(text, theme, true);
			}

			const { body, notice } = splitTrailingNoticeBlock(text);
			if (expanded) {
				return getTextComponent(joinSections(body || text || theme.fg("muted", "(no files)"), formatWarning(notice, theme)));
			}

			const count = countFindResults(text);
			const summary = `${theme.fg("muted", `↳ ${count} ${pluralize(count, "file")}`)} ${formatExpandHint()}`;
			return getTextComponent(joinSections(summary, formatWarning(notice, theme)));
		},
	});

	pi.registerTool({
		name: "ls",
		label: "ls",
		description: referenceTools.ls.description,
		parameters: referenceTools.ls.parameters,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).ls.execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme) {
			let text = `${theme.fg("toolTitle", theme.bold("ls"))} ${theme.fg("accent", formatDisplayPath(args.path ?? "."))}`;
			if (typeof args.limit === "number") {
				text += ` ${theme.fg("dim", `(limit ${args.limit})`)}`;
			}
			return getTextComponent(text);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) {
				return getTextComponent(theme.fg("muted", "Listing..."));
			}

			const text = extractTextContent(result);
			if (isLikelyErrorText(text)) {
				return renderRawText(text, theme, true);
			}

			const { body, notice } = splitTrailingNoticeBlock(text);
			if (expanded) {
				return getTextComponent(joinSections(body || text || theme.fg("muted", "(empty directory)"), formatWarning(notice, theme)));
			}

			const count = countLsEntries(text);
			const summary = `${theme.fg("muted", `↳ ${count} ${pluralize(count, "entry")}`)} ${formatExpandHint()}`;
			return getTextComponent(joinSections(summary, formatWarning(notice, theme)));
		},
	});
}
