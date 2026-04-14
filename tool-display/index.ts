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
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { renderStyledDiff } from "./diff-renderer";
import {
	buildPreview,
	countFindResults,
	countGrepMatches,
	countLines,
	countLsEntries,
	countReadLines,
	extractTextContent,
	formatDisplayPath,
	hasImageContent,
	splitTrailingNoticeBlock,
} from "./utils";

type BuiltInTools = ReturnType<typeof createBuiltInTools>;
type ToolDisplayDetails = {
	path?: string;
	content?: string;
};

const toolCache = new Map<string, BuiltInTools>();
const toolDisplayDetailsKey = "toolDisplay";

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

function getTextComponent(text: string) {
	return new Text(text, 0, 0);
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
	return count === 1 ? singular : plural;
}

function formatLineCount(count: number): string {
	return `${count} ${pluralize(count, "line")}`;
}

function formatEditorHint(description: string, theme: any): string {
	return `${theme.fg("dim", "ctrl+o")}${theme.fg("muted", ` ${description}`)}`;
}

function formatRemainingLinesHint(remainingLines: number, theme: any): string {
	return `${theme.fg("muted", `... (${remainingLines} more ${pluralize(remainingLines, "line")}, `)}${formatEditorHint("to expand", theme)}${theme.fg("muted", ")")}`;
}

function formatExpandHint(theme: any): string {
	return `(${formatEditorHint("to expand", theme)})`;
}

function formatWarning(notice: string | undefined, theme: any): string | undefined {
	return notice ? theme.fg("warning", notice) : undefined;
}

function joinSections(...parts: Array<string | undefined>): string {
	return parts.filter((part) => part && part.length > 0).join("\n");
}

function renderRawText(text: string, theme: any, isError: boolean) {
	const output = text.length > 0 ? text : isError ? "Error" : "(no output)";
	return getTextComponent(isError ? theme.fg("error", output) : output);
}

function renderDimmedText(text: string, theme: any): string {
	return theme.fg("dim", text);
}

function withToolDisplayDetails<T extends { details?: unknown }>(result: T, toolDisplay: ToolDisplayDetails): T {
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

function getToolDisplayDetails(result: { details?: unknown }): ToolDisplayDetails | undefined {
	const details = result.details;
	if (!details || typeof details !== "object" || Array.isArray(details)) {
		return undefined;
	}

	const toolDisplay = (details as Record<string, unknown>)[toolDisplayDetailsKey];
	if (!toolDisplay || typeof toolDisplay !== "object" || Array.isArray(toolDisplay)) {
		return undefined;
	}

	return toolDisplay as ToolDisplayDetails;
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

function isErrorResult(result: { isError?: boolean } | undefined, text: string): boolean {
	return result?.isError === true || isLikelyErrorText(text);
}

function countEditBlocks(args: Record<string, unknown> | undefined): number {
	const edits = args?.edits;
	if (Array.isArray(edits)) {
		return edits.length;
	}

	return typeof args?.oldText === "string" && typeof args?.newText === "string" ? 1 : 0;
}

function renderBashResult(
	result: { isError?: boolean; details?: unknown; content?: Array<{ type: string; text?: string }> },
	{ expanded, isPartial }: { expanded: boolean; isPartial: boolean },
	theme: any,
) {
	const text = extractTextContent(result);
	const isError = isErrorResult(result, text);

	if (isError) {
		const preview = buildPreview(text);
		const body = expanded ? text : preview.previewText;
		const output = body.length > 0 ? theme.fg("error", body) : undefined;
		const hint = !expanded && preview.hasMore ? formatRemainingLinesHint(preview.remainingLines, theme) : undefined;
		return getTextComponent(joinSections(theme.fg("error", "↳ command failed"), output, hint));
	}

	const { body, notice } = splitTrailingNoticeBlock(text);
	const previewSource = body.length > 0 ? body : text;
	const preview = buildPreview(previewSource);
	const status = isPartial ? theme.fg("warning", "running...") : undefined;
	const output = expanded ? previewSource : preview.previewText;
	const display = output.length > 0
		? renderDimmedText(output, theme)
		: !isPartial ? theme.fg("muted", "↳ (no output)") : undefined;
	const hint = !expanded && preview.hasMore ? formatRemainingLinesHint(preview.remainingLines, theme) : undefined;
	return getTextComponent(joinSections(status, display, hint, formatWarning(notice, theme)));
}

function getEditPrepareArguments(tool: unknown): ((args: unknown) => unknown) | undefined {
	const prepareArguments = (tool as { prepareArguments?: unknown })?.prepareArguments;
	return typeof prepareArguments === "function" ? prepareArguments : undefined;
}

function registerOverrides(pi: ExtensionAPI) {
	const referenceTools = getBuiltInTools(process.cwd());
	const editPrepareArguments = getEditPrepareArguments(referenceTools.edit);

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
			if (isErrorResult(result, text)) {
				return renderRawText(text, theme, true);
			}

			if (hasImageContent(result)) {
				return renderRawText(text || "Read image file", theme, false);
			}

			const { body, notice } = splitTrailingNoticeBlock(text);
			if (!expanded) {
				const lineCount = countReadLines(text);
				const summary = `${theme.fg("muted", `↳ loaded ${formatLineCount(lineCount)}`)} ${formatExpandHint(theme)}`;
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
			if (isErrorResult(result, text)) {
				return renderRawText(text, theme, true);
			}

			const content = getToolDisplayDetails(result)?.content ?? "";
			const preview = buildPreview(content);
			const body = expanded ? content : preview.previewText;
			const display = body.length > 0 ? renderDimmedText(body, theme) : theme.fg("muted", "(empty file)");
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
		renderResult(result, options, theme) {
			return renderBashResult(result, options, theme);
		},
	});

	pi.registerTool({
		name: "edit",
		label: "edit",
		description: referenceTools.edit.description,
		parameters: referenceTools.edit.parameters,
		...(editPrepareArguments ? { prepareArguments: editPrepareArguments } : {}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const result = await getBuiltInTools(ctx.cwd).edit.execute(toolCallId, params, signal, onUpdate);
			return withToolDisplayDetails(result, { path: params.path });
		},
		renderCall(args, theme) {
			const displayPath = formatDisplayPath(args.path ?? "");
			const editCount = countEditBlocks(args as Record<string, unknown> | undefined);
			const suffix = editCount > 0 ? ` ${theme.fg("muted", `(${editCount} ${pluralize(editCount, "block")})`)}` : "";
			const text = `${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", displayPath)}${suffix}`;
			return getTextComponent(text);
		},
		renderResult(result, { isPartial }, theme) {
			if (isPartial) {
				return getTextComponent(theme.fg("muted", "Editing..."));
			}

			const text = extractTextContent(result);
			if (isErrorResult(result, text)) {
				return renderRawText(text, theme, true);
			}

			const diff = typeof result.details?.diff === "string" ? result.details.diff : "";
			if (!diff) {
				return getTextComponent(theme.fg("success", "Applied"));
			}

			const path = getToolDisplayDetails(result)?.path;
			return renderStyledDiff(diff, path, theme);
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
			if (isErrorResult(result, text)) {
				return renderRawText(text, theme, true);
			}

			const { body, notice } = splitTrailingNoticeBlock(text);
			if (expanded) {
				return getTextComponent(joinSections(body || text || theme.fg("muted", "(no matches)"), formatWarning(notice, theme)));
			}

			const count = countGrepMatches(text);
			const summary = `${theme.fg("muted", `↳ ${count} ${pluralize(count, "match")}`)} ${formatExpandHint(theme)}`;
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
			if (isErrorResult(result, text)) {
				return renderRawText(text, theme, true);
			}

			const { body, notice } = splitTrailingNoticeBlock(text);
			if (expanded) {
				return getTextComponent(joinSections(body || text || theme.fg("muted", "(no files)"), formatWarning(notice, theme)));
			}

			const count = countFindResults(text);
			const summary = `${theme.fg("muted", `↳ ${count} ${pluralize(count, "file")}`)} ${formatExpandHint(theme)}`;
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
			if (isErrorResult(result, text)) {
				return renderRawText(text, theme, true);
			}

			const { body, notice } = splitTrailingNoticeBlock(text);
			if (expanded) {
				return getTextComponent(joinSections(body || text || theme.fg("muted", "(empty directory)"), formatWarning(notice, theme)));
			}

			const count = countLsEntries(text);
			const summary = `${theme.fg("muted", `↳ ${count} ${pluralize(count, "entry")}`)} ${formatExpandHint(theme)}`;
			return getTextComponent(joinSections(summary, formatWarning(notice, theme)));
		},
	});
}

export default function (pi: ExtensionAPI) {
	let hasRegisteredOverrides = false;

	pi.on("session_start", () => {
		if (hasRegisteredOverrides) {
			return;
		}

		const activeTools = pi.getActiveTools();
		registerOverrides(pi);
		pi.setActiveTools(activeTools);
		hasRegisteredOverrides = true;
	});
}
