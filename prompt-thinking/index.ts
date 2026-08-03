import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
	ThinkingSelectorComponent,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, Input, Text } from "@earendil-works/pi-tui";
import {
	buildThinkingAutocompleteItems,
	createThinkingAutocompleteProvider,
	stripThinkingLevelControlTokens,
	type ThinkingLevel,
} from "./utils";

type PendingPrompt = {
	promptText: string;
	overrideLevel: ThinkingLevel | null;
};

type ActiveOverride = {
	previousLevel: ThinkingLevel;
};

export default function (pi: ExtensionAPI) {
	let pendingPrompts: PendingPrompt[] = [];
	let activeOverride: ActiveOverride | null = null;

	function getSessionThinkingLevel(model: NonNullable<ExtensionContext["model"]>): ThinkingLevel {
		const level = clampThinkingLevel(model, activeOverride?.previousLevel ?? pi.getThinkingLevel());
		if (activeOverride) {
			activeOverride.previousLevel = level;
		}
		return level;
	}

	function setSessionThinkingLevel(level: ThinkingLevel) {
		if (activeOverride) {
			activeOverride.previousLevel = level;
		} else {
			pi.setThinkingLevel(level);
		}
	}

	function clearPromptState() {
		pendingPrompts = [];
		activeOverride = null;
	}

	function dequeuePrompt(promptText: string): PendingPrompt | undefined {
		const matchIndex = pendingPrompts.findIndex((entry) => entry.promptText === promptText);
		if (matchIndex < 0) {
			return undefined;
		}
		const staleCount = matchIndex;
		if (staleCount > 0) {
			pendingPrompts.splice(0, staleCount);
		}
		return pendingPrompts.shift();
	}

	pi.registerShortcut("alt+shift+tab", {
		description: "Cycle thinking level backward",
		handler: (ctx) => {
			const model = ctx.model;
			if (!model?.reasoning) {
				ctx.ui.notify("Current model does not support thinking", "info");
				return;
			}

			const levels = getSupportedThinkingLevels(model);
			const currentIndex = levels.indexOf(getSessionThinkingLevel(model));
			const previousLevel = levels.at(currentIndex > 0 ? currentIndex - 1 : -1);
			if (!previousLevel) {
				return;
			}
			setSessionThinkingLevel(previousLevel);
			ctx.ui.notify(`Thinking level: ${previousLevel}`, "info");
		},
	});

	pi.registerShortcut("ctrl+shift+t", {
		description: "Select thinking level",
		handler: async (ctx) => {
			const model = ctx.model;
			if (!model?.reasoning) {
				ctx.ui.notify("Current model does not support thinking", "info");
				return;
			}

			const levels = getSupportedThinkingLevels(model);
			const selection = await ctx.ui.custom<ThinkingLevel | null>((tui, _theme, _keybindings, done) => {
				const selector = new ThinkingSelectorComponent(
					getSessionThinkingLevel(model),
					levels,
					done,
					() => done(null),
				);
				const selectList = selector.getSelectList();
				const filterInput = new Input();
				const container = new Container();
				container.addChild(new Text("Filter:", 1, 0));
				container.addChild(filterInput);
				container.addChild(selector);

				return {
					get focused() {
						return filterInput.focused;
					},
					set focused(value: boolean) {
						filterInput.focused = value;
					},
					render: (width: number) => container.render(width),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => {
						const previousFilter = filterInput.getValue();
						filterInput.handleInput(data);
						if (filterInput.getValue() !== previousFilter) {
							selectList.setFilter(filterInput.getValue());
						}
						selectList.handleInput(data);
						tui.requestRender();
					},
				};
			});
			if (!selection) {
				return;
			}
			setSessionThinkingLevel(selection);
			ctx.ui.notify(`Thinking level: ${selection}`, "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		clearPromptState();
		if (ctx.hasUI) {
			ctx.ui.addAutocompleteProvider((current) =>
				createThinkingAutocompleteProvider(current, () =>
					buildThinkingAutocompleteItems(
						ctx.model ? getSupportedThinkingLevels(ctx.model) : ["off"],
						pi.getThinkingLevel(),
					),
				),
			);
		}
	});

	pi.on("session_shutdown", () => {
		if (activeOverride) {
			pi.setThinkingLevel(activeOverride.previousLevel);
		}
		clearPromptState();
	});

	pi.on("input", (event, _ctx) => {
		if (event.source === "extension") {
			return { action: "continue" as const };
		}

		const transformed = stripThinkingLevelControlTokens(event.text);
		pendingPrompts.push({
			promptText: transformed.text,
			overrideLevel: transformed.overrideLevel,
		});

		if (!transformed.changed) {
			return { action: "continue" as const };
		}

		return {
			action: "transform" as const,
			text: transformed.text,
			images: event.images,
		};
	});

	pi.on("before_agent_start", (event) => {
		const pendingPrompt = dequeuePrompt(event.prompt);
		if (!pendingPrompt?.overrideLevel) {
			return;
		}

		const previousLevel = pi.getThinkingLevel();
		activeOverride = { previousLevel };
		pi.setThinkingLevel(pendingPrompt.overrideLevel);
	});

	pi.on("agent_end", () => {
		if (!activeOverride) {
			return;
		}
		pi.setThinkingLevel(activeOverride.previousLevel);
		activeOverride = null;
	});
}
