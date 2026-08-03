import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
			if (!ctx.model?.reasoning) {
				ctx.ui.notify("Current model does not support thinking", "info");
				return;
			}

			const levels = getSupportedThinkingLevels(ctx.model);
			const sessionLevel = activeOverride?.previousLevel ?? pi.getThinkingLevel();
			const currentIndex = levels.indexOf(sessionLevel);
			const previousLevel = levels.at(currentIndex > 0 ? currentIndex - 1 : -1);
			if (!previousLevel) {
				return;
			}
			if (activeOverride) {
				activeOverride.previousLevel = previousLevel;
			} else {
				pi.setThinkingLevel(previousLevel);
			}
			ctx.ui.notify(`Thinking level: ${previousLevel}`, "info");
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
