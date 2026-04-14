import { getLanguageFromPath, highlightCode } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import { getDiffStats, splitLines } from "./utils";

type DiffTheme = {
	fg(color: string, text: string): string;
	bold?(text: string): string;
	getFgAnsi?(color: string): string;
	getBgAnsi?(color: string): string;
};

type RgbColor = {
	r: number;
	g: number;
	b: number;
};

type DiffPalette = {
	addRowBgAnsi: string;
	removeRowBgAnsi: string;
	containerBgAnsi?: string;
};

type ParsedDiffLine = {
	kind: "add" | "remove" | "context";
	lineNumber: string;
	content: string;
};

const diffLinePattern = /^([+\- ])(\s*\d*)\s(.*)$/;
const ANSI_BG_RESET = "\x1b[49m";
const ANSI_SGR_PATTERN = /\x1b\[([0-9;]*)m/g;
const ADD_ROW_BACKGROUND_MIX_RATIO = 0.24;
const REMOVE_ROW_BACKGROUND_MIX_RATIO = 0.12;
const ADDITION_TINT_TARGET: RgbColor = { r: 84, g: 190, b: 118 };
const DELETION_TINT_TARGET: RgbColor = { r: 232, g: 95, b: 122 };

function normalizeCodeWhitespace(text: string): string {
	return text.replace(/\t/g, "    ");
}

function emphasis(theme: DiffTheme, text: string): string {
	return typeof theme.bold === "function" ? theme.bold(text) : text;
}

function fitToWidth(text: string, width: number): string {
	const trimmed = truncateToWidth(text, width, "");
	const gap = Math.max(0, width - visibleWidth(trimmed));
	return gap > 0 ? `${trimmed}${" ".repeat(gap)}` : trimmed;
}

function wrapToWidth(text: string, width: number): string[] {
	if (width <= 0) {
		return [""];
	}

	const wrapped = wrapTextWithAnsi(text, width);
	if (wrapped.length === 0) {
		return [fitToWidth("", width)];
	}

	return wrapped.map((line) => fitToWidth(line, width));
}

function toSgrParams(rawParams: string): number[] {
	if (!rawParams.trim()) {
		return [0];
	}

	const parsed = rawParams
		.split(";")
		.map((token) => Number.parseInt(token, 10))
		.filter((value) => Number.isFinite(value));

	return parsed.length > 0 ? parsed : [];
}

function sequenceResetsBackground(params: number[]): boolean {
	for (const param of params) {
		if (param === 0 || param === 49) {
			return true;
		}
	}

	return false;
}

function keepBackgroundAcrossResets(text: string, rowBg: string): string {
	if (!text) {
		return text;
	}

	return text.replace(ANSI_SGR_PATTERN, (sequence, rawParams: string) => {
		const params = toSgrParams(rawParams);
		if (params.length === 0 || !sequenceResetsBackground(params)) {
			return sequence;
		}
		return `${sequence}${rowBg}`;
	});
}

function applyLineBackgroundToWidth(
	text: string,
	width: number,
	rowBgAnsi: string,
	restoreBgAnsi: string,
): string {
	if (width <= 0) {
		return "";
	}

	const fitted = fitToWidth(text, width);
	const stableText = keepBackgroundAcrossResets(fitted, rowBgAnsi);
	return `${rowBgAnsi}${stableText}${restoreBgAnsi}`;
}

function ansi256ToRgb(code: number): RgbColor {
	if (code < 0) {
		return { r: 0, g: 0, b: 0 };
	}
	if (code <= 15) {
		const base16: RgbColor[] = [
			{ r: 0, g: 0, b: 0 },
			{ r: 128, g: 0, b: 0 },
			{ r: 0, g: 128, b: 0 },
			{ r: 128, g: 128, b: 0 },
			{ r: 0, g: 0, b: 128 },
			{ r: 128, g: 0, b: 128 },
			{ r: 0, g: 128, b: 128 },
			{ r: 192, g: 192, b: 192 },
			{ r: 128, g: 128, b: 128 },
			{ r: 255, g: 0, b: 0 },
			{ r: 0, g: 255, b: 0 },
			{ r: 255, g: 255, b: 0 },
			{ r: 0, g: 0, b: 255 },
			{ r: 255, g: 0, b: 255 },
			{ r: 0, g: 255, b: 255 },
			{ r: 255, g: 255, b: 255 },
		];
		return base16[code] ?? { r: 255, g: 255, b: 255 };
	}
	if (code >= 232) {
		const value = Math.max(0, Math.min(255, 8 + (code - 232) * 10));
		return { r: value, g: value, b: value };
	}

	const cube = code - 16;
	const levels = [0, 95, 135, 175, 215, 255];
	const blue = cube % 6;
	const green = Math.floor(cube / 6) % 6;
	const red = Math.floor(cube / 36) % 6;
	return {
		r: levels[red] ?? 0,
		g: levels[green] ?? 0,
		b: levels[blue] ?? 0,
	};
}

function parseAnsiColorCode(ansi: string | undefined): RgbColor | null {
	if (!ansi) {
		return null;
	}

	const rgbMatch = /\x1b\[(?:3|4)8;2;(\d{1,3});(\d{1,3});(\d{1,3})m/.exec(ansi);
	if (rgbMatch) {
		const r = Number.parseInt(rgbMatch[1] ?? "0", 10);
		const g = Number.parseInt(rgbMatch[2] ?? "0", 10);
		const b = Number.parseInt(rgbMatch[3] ?? "0", 10);
		if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
			return {
				r: Math.max(0, Math.min(255, r)),
				g: Math.max(0, Math.min(255, g)),
				b: Math.max(0, Math.min(255, b)),
			};
		}
	}

	const ansi256Match = /\x1b\[(?:3|4)8;5;(\d{1,3})m/.exec(ansi);
	if (ansi256Match) {
		const code = Number.parseInt(ansi256Match[1] ?? "0", 10);
		if (Number.isFinite(code)) {
			return ansi256ToRgb(code);
		}
	}

	return null;
}

function rgbToBgAnsi(color: RgbColor): string {
	const r = Math.max(0, Math.min(255, Math.round(color.r)));
	const g = Math.max(0, Math.min(255, Math.round(color.g)));
	const b = Math.max(0, Math.min(255, Math.round(color.b)));
	return `\x1b[48;2;${r};${g};${b}m`;
}

function mixRgb(base: RgbColor, tint: RgbColor, ratio: number): RgbColor {
	const clamped = Math.max(0, Math.min(1, ratio));
	return {
		r: base.r * (1 - clamped) + tint.r * clamped,
		g: base.g * (1 - clamped) + tint.g * clamped,
		b: base.b * (1 - clamped) + tint.b * clamped,
	};
}

function readThemeAnsi(theme: DiffTheme, kind: "fg" | "bg", slot: string): string | undefined {
	try {
		if (kind === "fg" && typeof theme.getFgAnsi === "function") {
			return theme.getFgAnsi(slot);
		}
		if (kind === "bg" && typeof theme.getBgAnsi === "function") {
			return theme.getBgAnsi(slot);
		}
	} catch {
		return undefined;
	}

	return undefined;
}

function resolveDiffPalette(theme: DiffTheme): DiffPalette {
	const containerBgAnsi =
		readThemeAnsi(theme, "bg", "toolSuccessBg") ??
		readThemeAnsi(theme, "bg", "toolPendingBg") ??
		readThemeAnsi(theme, "bg", "toolErrorBg") ??
		readThemeAnsi(theme, "bg", "userMessageBg");
	const baseBg =
		parseAnsiColorCode(containerBgAnsi) ??
		parseAnsiColorCode(readThemeAnsi(theme, "bg", "userMessageBg")) ??
		{ r: 32, g: 35, b: 42 };
	const addFg = parseAnsiColorCode(readThemeAnsi(theme, "fg", "toolDiffAdded")) ?? { r: 88, g: 173, b: 88 };
	const removeFg = parseAnsiColorCode(readThemeAnsi(theme, "fg", "toolDiffRemoved")) ?? { r: 196, g: 98, b: 98 };
	const addTint = mixRgb(addFg, ADDITION_TINT_TARGET, 0.35);
	const removeTint = mixRgb(removeFg, DELETION_TINT_TARGET, 0.65);

	return {
		addRowBgAnsi: rgbToBgAnsi(mixRgb(baseBg, addTint, ADD_ROW_BACKGROUND_MIX_RATIO)),
		removeRowBgAnsi: rgbToBgAnsi(mixRgb(baseBg, removeTint, REMOVE_ROW_BACKGROUND_MIX_RATIO)),
		containerBgAnsi,
	};
}

function createCodeHighlighter(path: string | undefined): (line: string) => string {
	const language = path ? getLanguageFromPath(path) : undefined;
	if (!language) {
		return (line) => normalizeCodeWhitespace(line);
	}

	const cache = new Map<string, string>();
	return (line) => {
		const normalized = normalizeCodeWhitespace(line);
		const cached = cache.get(normalized);
		if (cached !== undefined) {
			return cached;
		}

		try {
			const highlighted = highlightCode(normalized, language)[0] ?? normalized;
			cache.set(normalized, highlighted);
			return highlighted;
		} catch {
			cache.set(normalized, normalized);
			return normalized;
		}
	};
}

function parseDiffLine(line: string): ParsedDiffLine | undefined {
	const match = line.match(diffLinePattern);
	if (!match) {
		return undefined;
	}

	const prefix = match[1] ?? " ";
	return {
		kind: prefix === "+" ? "add" : prefix === "-" ? "remove" : "context",
		lineNumber: (match[2] ?? "").trim(),
		content: match[3] ?? "",
	};
}

function colorizeSegment(theme: DiffTheme, color: string, text: string, rowBg: string | undefined): string {
	const themed = theme.fg(color, text);
	if (!rowBg) {
		return themed;
	}

	return `${rowBg}${keepBackgroundAcrossResets(themed, rowBg)}${rowBg}`;
}

function renderBalanceBar(stats: ReturnType<typeof getDiffStats>, theme: DiffTheme): string {
	const segments: string[] = [];
	if (stats.bar.added > 0) {
		segments.push(theme.fg("toolDiffAdded", "█".repeat(stats.bar.added)));
	}
	if (stats.bar.removed > 0) {
		segments.push(theme.fg("toolDiffRemoved", "█".repeat(stats.bar.removed)));
	}
	if (stats.bar.neutral > 0) {
		segments.push(theme.fg("muted", "·".repeat(stats.bar.neutral)));
	}
	return segments.join("");
}

function formatSummary(diff: string, width: number, theme: DiffTheme): string {
	const stats = getDiffStats(diff);
	const summaryPieces = [
		theme.fg("toolOutput", `↳ ${emphasis(theme, "diff")}`),
		theme.fg("toolDiffAdded", `+${stats.additions}`),
		theme.fg("toolDiffRemoved", `-${stats.removals}`),
		theme.fg("muted", `${stats.hunks} ${stats.hunks === 1 ? "hunk" : "hunks"}`),
		theme.fg("muted", `${stats.files} ${stats.files === 1 ? "file" : "files"}`),
	];
	const summary = summaryPieces.join(theme.fg("muted", " • "));
	const meter = renderBalanceBar(stats, theme);
	if (!meter || width < 24) {
		return truncateToWidth(summary, width);
	}

	const separator = " ";
	const meterWidth = visibleWidth(separator) + visibleWidth(meter);
	if (meterWidth >= width) {
		return truncateToWidth(summary, width);
	}

	return `${truncateToWidth(summary, Math.max(width - meterWidth, 0))}${separator}${meter}`;
}

function formatMetaLine(rawLine: string, width: number, theme: DiffTheme): string {
	const normalized = normalizeCodeWhitespace(rawLine);
	const color = normalized.startsWith("@@") ? "accent" : normalized.startsWith("+++") || normalized.startsWith("---") ? "muted" : "toolDiffContext";
	return truncateToWidth(theme.fg(color, normalized), width);
}

function renderRow(
	line: ParsedDiffLine,
	lineNumberWidth: number,
	width: number,
	theme: DiffTheme,
	highlightLine: (line: string) => string,
	palette: DiffPalette,
): string[] {
	const rowBg = line.kind === "add" ? palette.addRowBgAnsi : line.kind === "remove" ? palette.removeRowBgAnsi : undefined;
	const marker = line.kind === "add"
		? colorizeSegment(theme, "toolDiffAdded", "▌", rowBg)
		: line.kind === "remove"
			? colorizeSegment(theme, "toolDiffRemoved", "▌", rowBg)
			: " ";
	const numberText = line.lineNumber.padStart(lineNumberWidth, " ");
	const numberColor = line.kind === "add" ? "toolDiffAdded" : line.kind === "remove" ? "toolDiffRemoved" : "dim";
	const divider = colorizeSegment(theme, "dim", "│ ", rowBg);
	const prefix = `${marker} ${colorizeSegment(theme, numberColor, numberText, rowBg)} ${divider}`;
	const continuationPrefix = `${" ".repeat(2)}${colorizeSegment(theme, "dim", " ".repeat(lineNumberWidth), rowBg)} ${divider}`;
	const content = line.content.length > 0 ? highlightLine(line.content) : "";
	const codeWidth = Math.max(width - visibleWidth(prefix), 0);
	const wrappedLines = wrapToWidth(content, codeWidth);
	const restoreBg = palette.containerBgAnsi ?? ANSI_BG_RESET;

	return wrappedLines.map((wrappedLine, index) => {
		const rowText = `${index === 0 ? prefix : continuationPrefix}${wrappedLine}`;
		return rowBg ? applyLineBackgroundToWidth(rowText, width, rowBg, restoreBg) : fitToWidth(rowText, width);
	});
}

export function renderStyledDiff(diff: string, filePath: string | undefined, theme: DiffTheme): Component {
	const diffLines = splitLines(diff);
	const parsedLines = diffLines.map((line) => parseDiffLine(line));
	const lineNumberWidth = Math.max(
		2,
		...parsedLines
			.filter((line): line is ParsedDiffLine => line !== undefined)
			.map((line) => line.lineNumber.length),
	);
	const highlightLine = createCodeHighlighter(filePath);
	const palette = resolveDiffPalette(theme);

	let cachedWidth: number | undefined;
	let cachedLines: string[] | undefined;

	return {
		render(width: number): string[] {
			const safeWidth = Math.max(width, 1);
			if (cachedLines && cachedWidth === safeWidth) {
				return cachedLines;
			}

			const summary = formatSummary(diff, safeWidth, theme);
			const separator = theme.fg("dim", "─".repeat(safeWidth));
			const body = diffLines.length === 0
				? [theme.fg("muted", "(empty diff)")]
				: diffLines.flatMap((rawLine, index) => {
					const parsedLine = parsedLines[index];
					return parsedLine
						? renderRow(parsedLine, lineNumberWidth, safeWidth, theme, highlightLine, palette)
						: [formatMetaLine(rawLine, safeWidth, theme)];
				});

			cachedLines = [summary, separator, ...body];
			cachedWidth = safeWidth;
			return cachedLines;
		},
		invalidate() {
			cachedWidth = undefined;
			cachedLines = undefined;
		},
	};
}
