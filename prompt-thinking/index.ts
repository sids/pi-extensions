import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	buildThinkingAutocompleteItems,
	createThinkingAutocompleteProvider,
	getAvailableThinkingLevels,
	stripThinkingLevelControlTokens,
	type ThinkingLevel,
	type ThinkingModel,
} from "./utils";

type PendingPrompt = {
	promptText: string;
	overrideLevel: ThinkingLevel | null;
};

type ActiveOverride = {
	previousLevel: ThinkingLevel;
};

export default function (pi: ExtensionAPI) {
	let currentModel: ThinkingModel | null = null;
	let availableThinkingLevels: ThinkingLevel[] = ["off"];
	let pendingPrompts: PendingPrompt[] = [];
	let activeOverride: ActiveOverride | null = null;

	function getLiveThinkingLevel(): ThinkingLevel {
		return pi.getThinkingLevel() as ThinkingLevel;
	}

	function refreshAvailableThinkingLevels(model?: ThinkingModel | null) {
		if (model !== undefined) {
			currentModel = model;
		}
		availableThinkingLevels = getAvailableThinkingLevels(currentModel);
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

	pi.on("session_start", (_event, ctx) => {
		clearPromptState();
		refreshAvailableThinkingLevels((ctx.model as ThinkingModel | undefined) ?? null);
		if (ctx.hasUI) {
			ctx.ui.addAutocompleteProvider((current) =>
				createThinkingAutocompleteProvider(current, () =>
					buildThinkingAutocompleteItems(availableThinkingLevels, getLiveThinkingLevel()),
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

	pi.on("model_select", (event) => {
		refreshAvailableThinkingLevels(event.model as ThinkingModel);
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

		const previousLevel = getLiveThinkingLevel();
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
