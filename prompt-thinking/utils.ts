import { supportsXhigh } from "@mariozechner/pi-ai";
import type { AutocompleteItem, AutocompleteProvider } from "@mariozechner/pi-tui";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export const THINKING_LEVELS_WITHOUT_XHIGH = THINKING_LEVELS.slice(0, -1) as Exclude<ThinkingLevel, "xhigh">[];

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type ThinkingModel = {
	id: string;
	reasoning?: boolean;
};

/** Regex matching a ^thinking token ending at cursor position. */
const THINKING_TOKEN_PATTERN = /(?:^|\s)\^([a-zA-Z]*)$/;

/** Regex matching candidate ^thinking tokens anywhere in text. */
const THINKING_TOKEN_GLOBAL_PATTERN = /\^([a-zA-Z]+)/g;

function isWhitespaceBoundary(text: string, start: number, end: number): boolean {
	const before = start === 0 ? undefined : text[start - 1];
	const after = end >= text.length ? undefined : text[end];
	const beforeOkay = before === undefined || /\s/.test(before);
	const afterOkay = after === undefined || /\s/.test(after);
	return beforeOkay && afterOkay;
}

function isHorizontalWhitespace(char: string | undefined): boolean {
	return char === " " || char === "\t";
}

function mergeRemovalRange(ranges: Array<{ start: number; end: number }>, start: number, end: number): void {
	const last = ranges[ranges.length - 1];
	if (last && start <= last.end) {
		last.end = Math.max(last.end, end);
		return;
	}
	ranges.push({ start, end });
}

function getRemovalRange(text: string, start: number, end: number): { start: number; end: number } {
	let removeStart = start;
	let removeEnd = end;
	const before = start === 0 ? undefined : text[start - 1];
	const after = end >= text.length ? undefined : text[end];

	if (isHorizontalWhitespace(before) && isHorizontalWhitespace(after)) {
		removeEnd += 1;
	} else if (isHorizontalWhitespace(after) && (before === undefined || before === "\n" || before === "\r")) {
		removeEnd += 1;
	} else if (isHorizontalWhitespace(before) && (after === undefined || after === "\n" || after === "\r")) {
		removeStart -= 1;
	}

	return { start: removeStart, end: removeEnd };
}

export function normalizeThinkingLevel(value: string): ThinkingLevel | null {
	const normalized = value.trim().toLowerCase();
	return (THINKING_LEVELS as readonly string[]).includes(normalized) ? (normalized as ThinkingLevel) : null;
}

export function getAvailableThinkingLevels(model: ThinkingModel | null | undefined): ThinkingLevel[] {
	if (!model?.reasoning) {
		return ["off"];
	}
	return supportsXhigh(model as Parameters<typeof supportsXhigh>[0])
		? [...THINKING_LEVELS]
		: [...THINKING_LEVELS_WITHOUT_XHIGH];
}

/**
 * Detect an active ^thinking token at the cursor position.
 * Returns the full token (including `^`) and the query portion after `^`,
 * or null if the cursor is not in a thinking-token context.
 */
export function findThinkingTokenAtCursor(line: string, cursorCol: number): { token: string; query: string } | null {
	const beforeCursor = line.slice(0, cursorCol);
	const match = beforeCursor.match(THINKING_TOKEN_PATTERN);
	if (!match) {
		return null;
	}
	const query = match[1]!;
	return { token: `^${query}`, query };
}

/**
 * Remove recognized ^thinking control tokens from a prompt.
 * Unknown tokens are left unchanged.
 * If multiple recognized tokens are present, the first one wins and all
 * recognized tokens are removed from the submitted prompt.
 */
export function stripThinkingLevelControlTokens(text: string): {
	text: string;
	overrideLevel: ThinkingLevel | null;
	changed: boolean;
} {
	let overrideLevel: ThinkingLevel | null = null;
	const removals: Array<{ start: number; end: number }> = [];

	THINKING_TOKEN_GLOBAL_PATTERN.lastIndex = 0;
	let match = THINKING_TOKEN_GLOBAL_PATTERN.exec(text);
	while (match) {
		const fullMatch = match[0]!;
		const rawLevel = match[1]!;
		const start = match.index;
		const end = start + fullMatch.length;

		if (!isWhitespaceBoundary(text, start, end)) {
			match = THINKING_TOKEN_GLOBAL_PATTERN.exec(text);
			continue;
		}

		const level = normalizeThinkingLevel(rawLevel);
		if (!level) {
			match = THINKING_TOKEN_GLOBAL_PATTERN.exec(text);
			continue;
		}

		if (overrideLevel === null) {
			overrideLevel = level;
		}

		const removal = getRemovalRange(text, start, end);
		mergeRemovalRange(removals, removal.start, removal.end);
		match = THINKING_TOKEN_GLOBAL_PATTERN.exec(text);
	}

	if (removals.length === 0) {
		return { text, overrideLevel: null, changed: false };
	}

	let result = "";
	let cursor = 0;
	for (const removal of removals) {
		result += text.slice(cursor, removal.start);
		cursor = removal.end;
	}
	result += text.slice(cursor);

	return {
		text: result,
		overrideLevel,
		changed: result !== text,
	};
}

/**
 * Build autocomplete items from the currently available thinking levels.
 */
export function buildThinkingAutocompleteItems(
	availableLevels: ThinkingLevel[],
	currentLevel: ThinkingLevel,
): AutocompleteItem[] {
	return availableLevels.map((level) => ({
		value: level,
		label: level,
		description: level === currentLevel ? "current level" : undefined,
	}));
}

type AutocompleteRequestOptions = {
	signal?: AbortSignal;
	force?: boolean;
};

type CompatibleAutocompleteProvider = AutocompleteProvider &
	Record<string, unknown> & {
		getSuggestions(
			lines: string[],
			cursorLine: number,
			cursorCol: number,
			options?: AutocompleteRequestOptions,
		): any;
	};

/**
 * Wrap an autocomplete provider to add ^thinking suggestions.
 * Delegates all non-thinking-token behavior to the base provider.
 */
export function createThinkingAutocompleteProvider(
	baseProvider: AutocompleteProvider,
	getThinkingItems: () => AutocompleteItem[],
): AutocompleteProvider {
	const base = baseProvider as CompatibleAutocompleteProvider;
	const provider = {
		getSuggestions(lines: string[], cursorLine: number, cursorCol: number, options?: AutocompleteRequestOptions) {
			const line = lines[cursorLine] || "";
			const thinkingToken = findThinkingTokenAtCursor(line, cursorCol);
			if (thinkingToken) {
				const queryLower = thinkingToken.query.toLowerCase();
				const items = getThinkingItems().filter((item) => {
					if (queryLower === "") {
						return true;
					}
					return item.label.toLowerCase().startsWith(queryLower);
				});
				if (items.length > 0) {
					return { items, prefix: thinkingToken.token };
				}
			}
			return base.getSuggestions(lines, cursorLine, cursorCol, options);
		},

		applyCompletion(
			lines: string[],
			cursorLine: number,
			cursorCol: number,
			item: AutocompleteItem,
			prefix: string,
		) {
			if (prefix.startsWith("^")) {
				const line = lines[cursorLine] || "";
				const startCol = cursorCol - prefix.length;
				const completedValue = `^${item.value}`;
				const newLine = line.slice(0, startCol) + completedValue + line.slice(cursorCol);
				const newLines = [...lines];
				newLines[cursorLine] = newLine;
				return {
					lines: newLines,
					cursorLine,
					cursorCol: startCol + completedValue.length,
				};
			}
			return baseProvider.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},
	} as AutocompleteProvider & Record<string, unknown>;

	if (typeof base.getForceFileSuggestions === "function") {
		provider.getForceFileSuggestions = base.getForceFileSuggestions.bind(baseProvider);
	}
	if (typeof base.shouldTriggerFileCompletion === "function") {
		provider.shouldTriggerFileCompletion = base.shouldTriggerFileCompletion.bind(baseProvider);
	}

	return provider;
}
