import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ReviewModeState } from "./types";
import { createInactiveReviewModeState, isReviewModeState } from "./utils";

const require = createRequire(import.meta.url);

function requirePiTui() {
	try {
		return require("@earendil-works/pi-tui");
	} catch (error) {
		const code = (error as { code?: string }).code;
		if (code !== "MODULE_NOT_FOUND") {
			throw error;
		}
		return require(path.join(os.homedir(), ".bun", "install", "global", "node_modules", "@earendil-works", "pi-tui"));
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
const REVIEW_MODE_ALLOWED_TOOL_NAMES = new Set<string>([
	"read",
	"bash",
	"grep",
	"find",
	"ls",
	"fetch_url",
	"web_search",
	...REVIEW_ONLY_TOOL_NAMES,
]);

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
	let reviewStartPending = false;

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

	let activeToolsBeforeReviewMode: string[] | undefined;

	const withReviewModeTools = (baseTools: string[]) => [
		...baseTools.filter((toolName) => REVIEW_MODE_ALLOWED_TOOL_NAMES.has(toolName)),
		...REVIEW_ONLY_TOOL_NAMES.filter((toolName) => !baseTools.includes(toolName)),
	];

	const syncReviewTools = (previousState?: ReviewModeState) => {
		const activeTools = pi.getActiveTools();
		const nextTools = state.active
			? withReviewModeTools(state.activeToolsBeforeReviewMode ?? activeToolsBeforeReviewMode ?? activeTools)
			: activeToolsBeforeReviewMode ?? previousState?.activeToolsBeforeReviewMode ?? activeTools.filter((tool) => !REVIEW_ONLY_TOOL_NAME_SET.has(tool));

		if (!state.active) {
			activeToolsBeforeReviewMode = undefined;
		}

		if (areSameToolLists(activeTools, nextTools)) {
			return;
		}

		pi.setActiveTools(nextTools);
	};

	const applyBanner = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) {
			return;
		}

		if (!state.active && !reviewStartPending) {
			ctx.ui.setWidget(BANNER_WIDGET_KEY, undefined, { placement: "aboveEditor" });
			return;
		}

		ctx.ui.setWidget(
			BANNER_WIDGET_KEY,
			(_tui, theme) => ({
				render: (width: number) => {
					const { truncateToWidth } = getPiTui();
					const banner = state.active
						? `${theme.fg("warning", theme.bold(" Review mode active"))}${theme.fg("muted", "; /review to exit.")}`
						: `${theme.fg("warning", theme.bold(" Review mode pending"))}${theme.fg("muted", "; waiting for the current agent run to finish.")}`;
					return [truncateToWidth(banner, Math.max(1, width))];
				},
				invalidate: () => {},
			}),
			{ placement: "aboveEditor" },
		);
	};

	const setState = (ctx: ExtensionContext, nextState: ReviewModeState) => {
		const previousState = state;
		if (nextState.active) {
			activeToolsBeforeReviewMode = nextState.activeToolsBeforeReviewMode ?? activeToolsBeforeReviewMode ?? pi.getActiveTools();
			state = {
				...nextState,
				activeToolsBeforeReviewMode,
			};
		} else {
			state = nextState;
		}
		persistState();
		syncReviewTools(previousState);
		applyBanner(ctx);
	};

	const startReviewMode = (
		ctx: ExtensionContext,
		options: {
			originLeafId?: string;
			runId: string;
			targetHint: string;
			targetPrNumber?: number;
			targetPrRef?: string;
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
			...(options.targetPrNumber ? { targetPrNumber: options.targetPrNumber } : {}),
			...(options.targetPrRef ? { targetPrRef: options.targetPrRef } : {}),
			reviewInstructionsPrompt: options.reviewInstructionsPrompt,
			originModelProvider: options.originModelProvider,
			originModelId: options.originModelId,
			originThinkingLevel: options.originThinkingLevel,
		});
	};

	const setReviewStartPending = (ctx: ExtensionContext, pending: boolean) => {
		reviewStartPending = pending;
		applyBanner(ctx);
	};

	const refresh = (ctx: ExtensionContext) => {
		reviewStartPending = false;
		state = getLatestState(ctx);
		if (state.active && state.activeToolsBeforeReviewMode) {
			activeToolsBeforeReviewMode = state.activeToolsBeforeReviewMode;
		}
		syncReviewTools();
		applyBanner(ctx);
	};

	return {
		getState: () => state,
		setState,
		startReviewMode,
		setReviewStartPending,
		refresh,
		syncTools: syncReviewTools,
		applyBanner,
	};
}
