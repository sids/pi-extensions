import { describe, expect, test } from "bun:test";
import type { AutocompleteProvider } from "@mariozechner/pi-tui";
import mentionSkillsExtension from "../index";
import promptThinkingExtension from "../../prompt-thinking/index";

function createCommand(name: string, source: "extension" | "prompt" | "skill", path?: string) {
	return {
		name,
		source,
		sourceInfo: {
			path: path ?? `<${source}:${name}>`,
			source,
			scope: "temporary",
			origin: "top-level",
		},
	};
}

type Handler = (event: any, ctx: any) => any;
type ExtensionName = "mention" | "thinking";

function createHarness(commands: any[], extensionOrder: ExtensionName[] = ["mention"]) {
	const handlers = new Map<string, Handler[]>();
	const providerFactories: Array<(current: AutocompleteProvider) => AutocompleteProvider> = [];
	let currentThinkingLevel = "low";

	const pi = {
		on(name: string, handler: Handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		getCommands() {
			return commands;
		},
		getThinkingLevel() {
			return currentThinkingLevel;
		},
		setThinkingLevel(level: string) {
			currentThinkingLevel = level;
		},
	} as any;

	for (const extensionName of extensionOrder) {
		if (extensionName === "mention") {
			mentionSkillsExtension(pi);
			continue;
		}
		promptThinkingExtension(pi);
	}

	return {
		providerFactories,
		async emit(name: string, event: any = {}, ctx: any = {}) {
			const list = handlers.get(name) ?? [];
			let result;
			for (const handler of list) {
				result = await handler(event, ctx);
			}
			return result;
		},
		createSessionContext() {
			return {
				hasUI: true,
				model: { id: "claude-sonnet-4-5", reasoning: true },
				ui: {
					addAutocompleteProvider(factory: (current: AutocompleteProvider) => AutocompleteProvider) {
						providerFactories.push(factory);
					},
				},
			};
		},
	};
}

function createBaseProvider(): AutocompleteProvider {
	return {
		getSuggestions(lines, cursorLine, cursorCol) {
			const line = lines[cursorLine] ?? "";
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
}

function composeProviders(factories: Array<(current: AutocompleteProvider) => AutocompleteProvider>): AutocompleteProvider {
	let current = createBaseProvider();
	for (const factory of factories) {
		current = factory(current);
	}
	return current;
}

describe("mention-skills extension", () => {
	test("registers an autocomplete provider on session start", async () => {
		const harness = createHarness([createCommand("skill:commit", "skill", "/skills/commit/SKILL.md")]);

		await harness.emit("session_start", {}, harness.createSessionContext());
		expect(harness.providerFactories).toHaveLength(1);
	});

	test("transforms skill mentions using discovered skills", async () => {
		const harness = createHarness([
			createCommand("skill:commit", "skill", "/skills/commit/SKILL.md"),
			createCommand("skill:pdf", "skill", "/skills/pdf/SKILL.md"),
		]);

		await harness.emit("resources_discover");

		const result = await harness.emit(
			"input",
			{ text: "Use $commit and $pdf", images: [], source: "interactive" },
			{},
		);

		expect(result).toEqual({
			action: "transform",
			text: "Use /skills/commit/SKILL.md and /skills/pdf/SKILL.md",
			images: [],
		});
	});

	test("keeps $ and ^ autocomplete when prompt-thinking installs after mention-skills", async () => {
		const harness = createHarness(
			[createCommand("skill:commit", "skill", "/skills/commit/SKILL.md")],
			["mention", "thinking"],
		);

		await harness.emit("session_start", {}, harness.createSessionContext());
		const provider = composeProviders(harness.providerFactories);

		const mentionResult = provider.getSuggestions(["$"], 0, 1);
		expect(mentionResult?.items[0]?.value).toBe("$commit");

		const thinkingResult = provider.getSuggestions(["^"], 0, 1);
		expect(thinkingResult?.items[0]?.value).toBe("low");
	});

	test("keeps $ and ^ autocomplete when mention-skills installs after prompt-thinking", async () => {
		const harness = createHarness(
			[createCommand("skill:commit", "skill", "/skills/commit/SKILL.md")],
			["thinking", "mention"],
		);

		await harness.emit("session_start", {}, harness.createSessionContext());
		const provider = composeProviders(harness.providerFactories);

		const mentionResult = provider.getSuggestions(["$"], 0, 1);
		expect(mentionResult?.items[0]?.value).toBe("$commit");

		const thinkingResult = provider.getSuggestions(["^"], 0, 1);
		expect(thinkingResult?.items[0]?.value).toBe("low");
	});
});
