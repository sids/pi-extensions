import type { AutocompleteItem, AutocompleteProvider } from "@mariozechner/pi-tui";
import type { SlashCommandInfo } from "@mariozechner/pi-coding-agent";

/** Prefix used for skill command names (e.g. "skill:my-skill"). */
const SKILL_COMMAND_PREFIX = "skill:";

/** Regex matching a $mention token ending at cursor position. */
const MENTION_TOKEN_PATTERN = /(?:^|\s)\$([a-zA-Z0-9\-_]*)$/;

/** Regex matching $mention tokens anywhere in text. */
const MENTION_GLOBAL_PATTERN = /(?:^|(?<=\s))\$([a-zA-Z][a-zA-Z0-9\-_]*)/g;

/**
 * Extract discovered skills from slash command metadata.
 * Returns a map of normalized skill name → SKILL.md path.
 */
export function collectDiscoveredSkills(commands: SlashCommandInfo[]): Map<string, string> {
	const skills = new Map<string, string>();
	for (const cmd of commands) {
		const skillPath = cmd.sourceInfo?.path;
		if (cmd.source !== "skill" || !skillPath) {
			continue;
		}
		if (!cmd.name.startsWith(SKILL_COMMAND_PREFIX)) {
			continue;
		}
		const name = cmd.name.slice(SKILL_COMMAND_PREFIX.length).trim();
		if (name.length === 0) {
			continue;
		}
		// First occurrence wins for deterministic deduplication.
		if (!skills.has(name)) {
			skills.set(name, skillPath);
		}
	}
	return skills;
}

/**
 * Detect an active $mention token at the cursor position.
 * Returns the full token (including `$`) and the query portion after `$`,
 * or null if the cursor is not in a mention context.
 */
export function findMentionTokenAtCursor(line: string, cursorCol: number): { token: string; query: string } | null {
	const beforeCursor = line.slice(0, cursorCol);
	const match = beforeCursor.match(MENTION_TOKEN_PATTERN);
	if (!match) {
		return null;
	}
	const query = match[1]!;
	return { token: `$${query}`, query };
}

/**
 * Replace all known $skill-name mentions in text with their full SKILL.md paths.
 * Unknown mentions are left unchanged.
 */
export function replaceSkillMentions(text: string, skillMap: Map<string, string>): string {
	return text.replace(MENTION_GLOBAL_PATTERN, (fullMatch, name: string) => {
		const path = skillMap.get(name);
		return path !== undefined ? path : fullMatch;
	});
}

/**
 * Build autocomplete items from the current skill map.
 */
export function buildSkillAutocompleteItems(skillMap: Map<string, string>): AutocompleteItem[] {
	const items: AutocompleteItem[] = [];
	for (const [name, path] of skillMap) {
		items.push({
			value: `$${name}`,
			label: `$${name}`,
			description: path,
		});
	}
	return items;
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
 * Wrap an autocomplete provider to add $mention suggestions for skills.
 * Delegates all non-mention behavior to the base provider.
 */
export function createMentionAutocompleteProvider(
	baseProvider: AutocompleteProvider,
	getSkillItems: () => AutocompleteItem[],
): AutocompleteProvider {
	const base = baseProvider as CompatibleAutocompleteProvider;
	const provider = {
		getSuggestions(lines: string[], cursorLine: number, cursorCol: number, options?: AutocompleteRequestOptions) {
			const line = lines[cursorLine] || "";
			const mention = findMentionTokenAtCursor(line, cursorCol);
			if (mention) {
				const queryLower = mention.query.toLowerCase();
				const items = getSkillItems().filter((item) => {
					if (queryLower === "") {
						return true;
					}
					return item.label.toLowerCase().includes(queryLower);
				});
				if (items.length > 0) {
					return { items, prefix: mention.token };
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
			if (prefix.startsWith("$")) {
				const line = lines[cursorLine] || "";
				const startCol = cursorCol - prefix.length;
				const newLine = line.slice(0, startCol) + item.value + line.slice(cursorCol);
				const newLines = [...lines];
				newLines[cursorLine] = newLine;
				return {
					lines: newLines,
					cursorLine,
					cursorCol: startCol + item.value.length,
				};
			}
			return baseProvider.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},
	} as AutocompleteProvider & Record<string, unknown>;

	// Delegate optional methods from CombinedAutocompleteProvider.
	if (typeof base.getForceFileSuggestions === "function") {
		provider.getForceFileSuggestions = base.getForceFileSuggestions.bind(baseProvider);
	}
	if (typeof base.shouldTriggerFileCompletion === "function") {
		provider.shouldTriggerFileCompletion = base.shouldTriggerFileCompletion.bind(baseProvider);
	}

	return provider;
}
