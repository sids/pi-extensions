import { describe, expect, test } from "bun:test";
import type { AutocompleteItem, AutocompleteProvider } from "@mariozechner/pi-tui";
import type { SlashCommandInfo } from "@mariozechner/pi-coding-agent";
import {
	buildSkillAutocompleteItems,
	collectDiscoveredSkills,
	createMentionAutocompleteProvider,
	findMentionTokenAtCursor,
	replaceSkillMentions,
} from "../utils";

function createCommand(
	name: string,
	source: SlashCommandInfo["source"],
	path: string | null = `<${source}:${name}>`,
): SlashCommandInfo {
	return {
		name,
		source,
		sourceInfo: {
			path: path ?? "",
			source,
			scope: "temporary",
			origin: "top-level",
		},
	};
}

// --- collectDiscoveredSkills ---

describe("collectDiscoveredSkills", () => {
	test("extracts skills from command metadata", () => {
		const commands: SlashCommandInfo[] = [
			createCommand("skill:commit", "skill", "/home/.agents/skills/commit/SKILL.md"),
			createCommand("skill:pdf", "skill", "/home/.agents/skills/pdf/SKILL.md"),
		];
		const result = collectDiscoveredSkills(commands);
		expect(result.size).toBe(2);
		expect(result.get("commit")).toBe("/home/.agents/skills/commit/SKILL.md");
		expect(result.get("pdf")).toBe("/home/.agents/skills/pdf/SKILL.md");
	});

	test("ignores non-skill commands", () => {
		const commands: SlashCommandInfo[] = [
			createCommand("review", "extension"),
			createCommand("plan-md", "extension"),
			createCommand("skill:git", "skill", "/skills/git/SKILL.md"),
		];
		const result = collectDiscoveredSkills(commands);
		expect(result.size).toBe(1);
		expect(result.get("git")).toBe("/skills/git/SKILL.md");
	});

	test("ignores skill commands without path", () => {
		const commands: SlashCommandInfo[] = [
			createCommand("skill:orphan", "skill", null),
		];
		expect(collectDiscoveredSkills(commands).size).toBe(0);
	});

	test("ignores commands with non-skill: prefix", () => {
		const commands: SlashCommandInfo[] = [
			createCommand("prompt:foo", "prompt", "/prompts/foo.md"),
		];
		expect(collectDiscoveredSkills(commands).size).toBe(0);
	});

	test("first occurrence wins on duplicate names", () => {
		const commands: SlashCommandInfo[] = [
			createCommand("skill:dup", "skill", "/first/SKILL.md"),
			createCommand("skill:dup", "skill", "/second/SKILL.md"),
		];
		const result = collectDiscoveredSkills(commands);
		expect(result.size).toBe(1);
		expect(result.get("dup")).toBe("/first/SKILL.md");
	});

	test("ignores empty name after prefix", () => {
		const commands: SlashCommandInfo[] = [
			createCommand("skill:", "skill", "/broken/SKILL.md"),
		];
		expect(collectDiscoveredSkills(commands).size).toBe(0);
	});

	test("returns empty map for empty input", () => {
		expect(collectDiscoveredSkills([]).size).toBe(0);
	});
});

// --- findMentionTokenAtCursor ---

describe("findMentionTokenAtCursor", () => {
	test("detects $ at start of line", () => {
		expect(findMentionTokenAtCursor("$", 1)).toEqual({ token: "$", query: "" });
	});

	test("detects $partial at start of line", () => {
		expect(findMentionTokenAtCursor("$com", 4)).toEqual({ token: "$com", query: "com" });
	});

	test("detects $ after whitespace", () => {
		expect(findMentionTokenAtCursor("hello $", 7)).toEqual({ token: "$", query: "" });
	});

	test("detects $partial after whitespace", () => {
		expect(findMentionTokenAtCursor("use $pdf here", 8)).toEqual({ token: "$pdf", query: "pdf" });
	});

	test("returns null when cursor not at mention", () => {
		expect(findMentionTokenAtCursor("hello world", 5)).toBeNull();
	});

	test("returns null for $ embedded in word", () => {
		expect(findMentionTokenAtCursor("cost$100", 8)).toBeNull();
	});

	test("handles hyphenated names", () => {
		expect(findMentionTokenAtCursor("$web-browser", 12)).toEqual({ token: "$web-browser", query: "web-browser" });
	});

	test("handles underscored names", () => {
		expect(findMentionTokenAtCursor("$my_skill", 9)).toEqual({ token: "$my_skill", query: "my_skill" });
	});

	test("returns null for cursor before the $", () => {
		expect(findMentionTokenAtCursor("$commit", 0)).toBeNull();
	});

	test("detects partial when cursor is mid-token", () => {
		expect(findMentionTokenAtCursor("$commit", 4)).toEqual({ token: "$com", query: "com" });
	});

	test("detects $ after tab", () => {
		expect(findMentionTokenAtCursor("\t$sk", 4)).toEqual({ token: "$sk", query: "sk" });
	});
});

// --- replaceSkillMentions ---

describe("replaceSkillMentions", () => {
	const skillMap = new Map([
		["commit", "/skills/commit/SKILL.md"],
		["pdf", "/skills/pdf/SKILL.md"],
		["web-browser", "/skills/web-browser/SKILL.md"],
	]);

	test("replaces single mention", () => {
		expect(replaceSkillMentions("Use $commit for this", skillMap)).toBe(
			"Use /skills/commit/SKILL.md for this",
		);
	});

	test("replaces multiple mentions", () => {
		expect(replaceSkillMentions("$commit and $pdf", skillMap)).toBe(
			"/skills/commit/SKILL.md and /skills/pdf/SKILL.md",
		);
	});

	test("replaces mention at start of text", () => {
		expect(replaceSkillMentions("$pdf extract tables", skillMap)).toBe(
			"/skills/pdf/SKILL.md extract tables",
		);
	});

	test("leaves unknown mentions unchanged", () => {
		expect(replaceSkillMentions("Use $unknown here", skillMap)).toBe("Use $unknown here");
	});

	test("handles mixed known and unknown", () => {
		expect(replaceSkillMentions("$commit and $nope", skillMap)).toBe(
			"/skills/commit/SKILL.md and $nope",
		);
	});

	test("handles hyphenated skill names", () => {
		expect(replaceSkillMentions("$web-browser", skillMap)).toBe("/skills/web-browser/SKILL.md");
	});

	test("does not replace $ embedded in words", () => {
		expect(replaceSkillMentions("cost$commit", skillMap)).toBe("cost$commit");
	});

	test("no-op when no mentions present", () => {
		const text = "plain text without mentions";
		expect(replaceSkillMentions(text, skillMap)).toBe(text);
	});

	test("no-op with empty skill map", () => {
		const empty = new Map<string, string>();
		expect(replaceSkillMentions("$commit", empty)).toBe("$commit");
	});

	test("preserves surrounding whitespace", () => {
		expect(replaceSkillMentions("  $pdf  ", skillMap)).toBe("  /skills/pdf/SKILL.md  ");
	});

	test("handles mention at end of text", () => {
		expect(replaceSkillMentions("read $commit", skillMap)).toBe("read /skills/commit/SKILL.md");
	});

	test("does not replace bare $ without name", () => {
		expect(replaceSkillMentions("cost is $", skillMap)).toBe("cost is $");
	});
});

// --- buildSkillAutocompleteItems ---

describe("buildSkillAutocompleteItems", () => {
	test("builds items from skill map", () => {
		const skillMap = new Map([
			["commit", "/skills/commit/SKILL.md"],
			["pdf", "/skills/pdf/SKILL.md"],
		]);
		const items = buildSkillAutocompleteItems(skillMap);
		expect(items).toEqual([
			{ value: "$commit", label: "$commit", description: "/skills/commit/SKILL.md" },
			{ value: "$pdf", label: "$pdf", description: "/skills/pdf/SKILL.md" },
		]);
	});

	test("returns empty array for empty map", () => {
		expect(buildSkillAutocompleteItems(new Map())).toEqual([]);
	});
});

// --- createMentionAutocompleteProvider ---

describe("createMentionAutocompleteProvider", () => {
	const skillItems: AutocompleteItem[] = [
		{ value: "$commit", label: "$commit", description: "/skills/commit/SKILL.md" },
		{ value: "$pdf", label: "$pdf", description: "/skills/pdf/SKILL.md" },
		{ value: "$web-browser", label: "$web-browser", description: "/skills/web-browser/SKILL.md" },
	];

	const baseProvider: AutocompleteProvider = {
		getSuggestions(lines, cursorLine, cursorCol) {
			const line = lines[cursorLine] || "";
			const before = line.slice(0, cursorCol);
			if (before.startsWith("/")) {
				return { items: [{ value: "/help", label: "/help" }], prefix: before };
			}
			return null;
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			const line = lines[cursorLine] || "";
			const startCol = cursorCol - prefix.length;
			const newLine = line.slice(0, startCol) + item.value + line.slice(cursorCol);
			const newLines = [...lines];
			newLines[cursorLine] = newLine;
			return { lines: newLines, cursorLine, cursorCol: startCol + item.value.length };
		},
	};

	function makeProvider() {
		return createMentionAutocompleteProvider(baseProvider, () => skillItems);
	}

	describe("getSuggestions", () => {
		test("returns all skills for bare $", () => {
			const provider = makeProvider();
			const result = provider.getSuggestions(["$"], 0, 1);
			expect(result).not.toBeNull();
			expect(result!.items).toEqual(skillItems);
			expect(result!.prefix).toBe("$");
		});

		test("filters skills by partial query", () => {
			const provider = makeProvider();
			const result = provider.getSuggestions(["$com"], 0, 4);
			expect(result).not.toBeNull();
			expect(result!.items).toHaveLength(1);
			expect(result!.items[0]!.value).toBe("$commit");
			expect(result!.prefix).toBe("$com");
		});

		test("returns null when no skills match", () => {
			const provider = makeProvider();
			const result = provider.getSuggestions(["$zzz"], 0, 4);
			// No skill matches "zzz", fall through to base which returns null for non-/
			expect(result).toBeNull();
		});

		test("delegates to base provider outside mention context", () => {
			const provider = makeProvider();
			const result = provider.getSuggestions(["/he"], 0, 3);
			expect(result).not.toBeNull();
			expect(result!.items[0]!.value).toBe("/help");
		});

		test("filters case-insensitively", () => {
			const provider = makeProvider();
			const result = provider.getSuggestions(["$COM"], 0, 4);
			expect(result).not.toBeNull();
			expect(result!.items).toHaveLength(1);
			expect(result!.items[0]!.value).toBe("$commit");
		});

		test("handles $ after whitespace", () => {
			const provider = makeProvider();
			const result = provider.getSuggestions(["use $pd"], 0, 7);
			expect(result).not.toBeNull();
			expect(result!.items).toHaveLength(1);
			expect(result!.items[0]!.value).toBe("$pdf");
			expect(result!.prefix).toBe("$pd");
		});

		test("does not trigger for $ embedded in word", () => {
			const provider = makeProvider();
			// "cost$100" — cursor at col 8, but $ is not after whitespace
			const result = provider.getSuggestions(["cost$pdf"], 0, 8);
			expect(result).toBeNull();
		});
	});

	describe("applyCompletion", () => {
		test("replaces $prefix with selected value", () => {
			const provider = makeProvider();
			const result = provider.applyCompletion(["$com"], 0, 4, skillItems[0]!, "$com");
			expect(result.lines).toEqual(["$commit"]);
			expect(result.cursorCol).toBe(7);
		});

		test("replaces in middle of line", () => {
			const provider = makeProvider();
			const result = provider.applyCompletion(
				["use $pd for extraction"],
				0,
				7,
				skillItems[1]!,
				"$pd",
			);
			expect(result.lines).toEqual(["use $pdf for extraction"]);
			expect(result.cursorCol).toBe(8);
		});

		test("delegates to base for non-$ prefix", () => {
			const provider = makeProvider();
			const result = provider.applyCompletion(
				["/he"],
				0,
				3,
				{ value: "/help", label: "/help" },
				"/he",
			);
			expect(result.lines).toEqual(["/help"]);
		});

		test("handles bare $ prefix", () => {
			const provider = makeProvider();
			const result = provider.applyCompletion(["$"], 0, 1, skillItems[0]!, "$");
			expect(result.lines).toEqual(["$commit"]);
			expect(result.cursorCol).toBe(7);
		});
	});

	describe("optional method delegation", () => {
		test("delegates getForceFileSuggestions when present", () => {
			const extendedBase = {
				...baseProvider,
				getForceFileSuggestions(lines: string[], cursorLine: number, cursorCol: number) {
					return { items: [{ value: "file.ts", label: "file.ts" }], prefix: "" };
				},
				shouldTriggerFileCompletion() {
					return true;
				},
			};
			const provider = createMentionAutocompleteProvider(extendedBase, () => skillItems) as Record<string, unknown>;
			expect(typeof provider.getForceFileSuggestions).toBe("function");
			expect(typeof provider.shouldTriggerFileCompletion).toBe("function");
		});

		test("omits optional methods when base lacks them", () => {
			const provider = makeProvider() as Record<string, unknown>;
			expect(provider.getForceFileSuggestions).toBeUndefined();
			expect(provider.shouldTriggerFileCompletion).toBeUndefined();
		});
	});
});
