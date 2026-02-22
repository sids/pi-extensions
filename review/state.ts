import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ReviewModeState } from "./types";
import { createInactiveReviewModeState, isReviewModeState } from "./utils";

const require = createRequire(import.meta.url);

function requirePiTui() {
	try {
		return require("@mariozechner/pi-tui");
	} catch (error) {
		const code = (error as { code?: string }).code;
		if (code !== "MODULE_NOT_FOUND") {
			throw error;
		}
		return require(path.join(os.homedir(), ".bun", "install", "global", "node_modules", "@mariozechner", "pi-tui"));
	}
}

function getPiTui() {
	return requirePiTui() as {
		truncateToWidth: (text: string, width: number) => string;
	};
}

export const STATE_ENTRY_TYPE = "review-mode:state";
export const CONTEXT_ENTRY_TYPE = "review-mode:context";

const BANNER_WIDGET_KEY = "review-mode-banner";
const REVIEW_ONLY_TOOL_NAMES = ["add_review_comment"] as const;
const REVIEW_ONLY_TOOL_NAME_SET = new Set<string>(REVIEW_ONLY_TOOL_NAMES);

export function getLatestState(ctx: ExtensionContext): ReviewModeState {
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) {
			continue;
		}
		if (isReviewModeState(entry.data)) {
			return entry.data;
		}
	}
	return createInactiveReviewModeState();
}

export function hasEntryInSession(ctx: ExtensionContext, entryId: string | undefined): boolean {
	if (!entryId) {
		return false;
	}
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.id === entryId) {
			return true;
		}
	}
	return false;
}

export function getFirstUserMessageId(ctx: ExtensionContext): string | undefined {
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "message" && entry.message.role === "user") {
			return entry.id;
		}
	}
	return undefined;
}

export function createReviewModeStateManager(pi: ExtensionAPI) {
	let state: ReviewModeState = createInactiveReviewModeState();

	const persistState = () => {
		pi.appendEntry(STATE_ENTRY_TYPE, state);
	};

	const areSameToolLists = (left: string[], right: string[]) => {
		if (left.length !== right.length) {
			return false;
		}
		for (let i = 0; i < left.length; i++) {
			if (left[i] !== right[i]) {
				return false;
			}
		}
		return true;
	};

	const syncReviewTools = () => {
		const activeTools = pi.getActiveTools();
		const nextTools = state.active
			? [...activeTools, ...REVIEW_ONLY_TOOL_NAMES.filter((tool) => !activeTools.includes(tool))]
			: activeTools.filter((tool) => !REVIEW_ONLY_TOOL_NAME_SET.has(tool));

		if (areSameToolLists(activeTools, nextTools)) {
			return;
		}

		pi.setActiveTools(nextTools);
	};

	const applyBanner = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) {
			return;
		}

		if (!state.active) {
			ctx.ui.setWidget(BANNER_WIDGET_KEY, undefined, { placement: "aboveEditor" });
			return;
		}

		ctx.ui.setWidget(
			BANNER_WIDGET_KEY,
			(_tui, theme) => ({
				render: (width: number) => {
					const { truncateToWidth } = getPiTui();
					return [
						truncateToWidth(
							`${theme.fg("warning", theme.bold(" Review mode active"))}${theme.fg("muted", "; /review to exit.")}`,
							Math.max(1, width),
						),
					];
				},
				invalidate: () => {},
			}),
			{ placement: "aboveEditor" },
		);
	};

	const setState = (ctx: ExtensionContext, nextState: ReviewModeState) => {
		state = nextState;
		persistState();
		syncReviewTools();
		applyBanner(ctx);
	};

	const startReviewMode = (
		ctx: ExtensionContext,
		options: {
			originLeafId?: string;
			runId: string;
			targetHint: string;
			reviewInstructionsPrompt: string;
			originModelProvider?: string;
			originModelId?: string;
			originThinkingLevel?: string;
		},
	) => {
		setState(ctx, {
			version: state.version,
			active: true,
			originLeafId: options.originLeafId,
			lastReviewLeafId: state.lastReviewLeafId,
			runId: options.runId,
			targetHint: options.targetHint,
			reviewInstructionsPrompt: options.reviewInstructionsPrompt,
			originModelProvider: options.originModelProvider,
			originModelId: options.originModelId,
			originThinkingLevel: options.originThinkingLevel,
		});
	};

	const refresh = (ctx: ExtensionContext) => {
		state = getLatestState(ctx);
		syncReviewTools();
		applyBanner(ctx);
	};

	return {
		getState: () => state,
		setState,
		startReviewMode,
		refresh,
		syncTools: syncReviewTools,
		applyBanner,
	};
}
