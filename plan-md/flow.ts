import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { loadPlanModePrompt } from "./prompts";
import { buildImplementationPrefill, PLAN_MODE_END_OPTIONS, PLAN_MODE_START_OPTIONS } from "./utils";
import {
	createFreshPlanFilePath,
	ensurePlanFileExists,
	movePlanFile,
	pathExists,
	readPlanFile,
	resolveActivePlanFilePath,
	resolvePlanLocationInput,
	resetPlanFile,
} from "./plan-files";
import { getFirstUserMessageId, hasEntryInSession } from "./state";
import type { PlanModeState } from "./types";

export const PLAN_MODE_PROMPT_ENTRY_TYPE = "plan-md:prompt";

async function sendPlanModePromptMessage(pi: ExtensionAPI) {
	const prompt = await loadPlanModePrompt();
	pi.sendMessage({
		customType: PLAN_MODE_PROMPT_ENTRY_TYPE,
		content: "Plan mode instructions",
		display: true,
		details: {
			instructionsPrompt: prompt,
		},
	});
}

type PlanModeStateManager = {
	getState: () => PlanModeState;
	setState: (ctx: ExtensionContext, nextState: PlanModeState) => void;
	startPlanMode: (
		ctx: ExtensionContext,
		options: {
			originLeafId?: string | null;
			planFilePath: string;
		},
	) => void;
};

type PlanModeExitSummary = {
	planFilePath: string;
	planText?: string;
};

type PlanModeEndAction = "exit" | "stay-current";

type MutableSessionManager = ExtensionContext["sessionManager"] & {
	branch?: (entryId: string) => void;
	resetLeaf?: () => void;
	appendCustomEntry?: (customType: string, data?: unknown) => string;
	getEntry?: (entryId: string) =>
		| {
			id?: string;
			type?: string;
			customType?: string;
			parentId?: string | null;
			message?: {
				role?: string;
				content?: unknown;
			};
			content?: unknown;
		}
		| undefined;
	appendLabelChange?: (targetId: string, label: string | undefined) => void;
};

const RESTORE_ANCHOR_ENTRY_TYPE = "plan-md:restore-anchor";

async function navigateToFreshPlanningBranch(
	ctx: ExtensionContext,
	cancelMessage: string,
): Promise<boolean> {
	const firstUserMessageId = getFirstUserMessageId(ctx);
	if (!firstUserMessageId) {
		ctx.ui.notify("No user message found to branch planning from.", "error");
		return false;
	}

	try {
		const navigateResult = await ctx.navigateTree(firstUserMessageId, {
			summarize: false,
			label: "plan-md",
		});
		if (navigateResult.cancelled) {
			ctx.ui.notify(cancelMessage, "info");
			return false;
		}
	} catch (error) {
		ctx.ui.notify(
			`Failed to create a fresh planning branch: ${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
		return false;
	}

	if (ctx.hasUI) {
		ctx.ui.setEditorText("");
	}
	return true;
}

async function navigateToSavedPlanningBranch(
	ctx: ExtensionContext,
	options: {
		savedLeafId?: string;
		currentLeafId?: string;
		cancelMessage: string;
	},
): Promise<boolean> {
	if (!options.savedLeafId || options.savedLeafId === options.currentLeafId) {
		return true;
	}

	if (!hasEntryInSession(ctx, options.savedLeafId)) {
		ctx.ui.notify("Saved planning branch is unavailable. Continuing from the current branch tip.", "warning");
		return true;
	}

	try {
		const navigateResult = await ctx.navigateTree(options.savedLeafId, {
			summarize: false,
			label: "plan-md",
		});
		if (navigateResult.cancelled) {
			ctx.ui.notify(options.cancelMessage, "info");
			return false;
		}
		if (ctx.hasUI) {
			ctx.ui.notify("Resumed previous planning branch.", "info");
		}
	} catch (error) {
		ctx.ui.notify(
			`Failed to resume the saved planning branch: ${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
		return false;
	}

	return true;
}

function getSessionEntryById(ctx: ExtensionContext, entryId: string) {
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.id === entryId) {
			return entry;
		}
	}
	return undefined;
}

function isRootUserMessageEntry(entry: ReturnType<typeof getSessionEntryById>): boolean {
	return entry?.type === "message" && entry.parentId === null && entry.message.role === "user";
}

function setSessionLeaf(sessionManager: MutableSessionManager, leafId: string | null): boolean {
	if (leafId === null) {
		if (typeof sessionManager.resetLeaf !== "function") {
			return false;
		}
		sessionManager.resetLeaf();
		return true;
	}

	if (typeof sessionManager.branch !== "function") {
		return false;
	}
	sessionManager.branch(leafId);
	return true;
}

function findRestoreAnchorId(ctx: ExtensionContext, parentId: string | null): string | undefined {
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (
			entry.type === "custom" &&
			entry.customType === RESTORE_ANCHOR_ENTRY_TYPE &&
			entry.parentId === parentId
		) {
			return entry.id;
		}
	}
	return undefined;
}

function getOrCreateRestoreAnchor(
	ctx: ExtensionContext,
	parentId: string | null,
	restoreLeafId: string | null,
): string | null {
	const existingAnchorId = findRestoreAnchorId(ctx, parentId);
	if (existingAnchorId) {
		return existingAnchorId;
	}

	const sessionManager = ctx.sessionManager as MutableSessionManager;
	if (typeof sessionManager.appendCustomEntry !== "function") {
		return null;
	}
	if (!setSessionLeaf(sessionManager, parentId)) {
		return null;
	}

	try {
		return sessionManager.appendCustomEntry(RESTORE_ANCHOR_ENTRY_TYPE, { parentId });
	} finally {
		setSessionLeaf(sessionManager, restoreLeafId);
	}
}

async function restorePlanModeOrigin(
	ctx: ExtensionContext,
	originLeafId: string | null | undefined,
	planningLeafId: string | null,
): Promise<boolean> {
	if (originLeafId === undefined) {
		return true;
	}

	if (originLeafId === null) {
		const anchorId = getOrCreateRestoreAnchor(ctx, null, planningLeafId);
		if (!anchorId) {
			ctx.ui.notify("Could not fully restore the empty-root origin. Ended planning at the current branch tip.", "warning");
			return true;
		}

		try {
			const navigateResult = await ctx.navigateTree(anchorId, { summarize: false });
			if (navigateResult.cancelled) {
				ctx.ui.notify("Returning from plan mode was cancelled. Use /plan-md to try again.", "info");
				return false;
			}
		} catch (error) {
			ctx.ui.notify(
				`Failed to restore origin point: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return false;
		}

		const sessionManager = ctx.sessionManager as MutableSessionManager;
		if (!setSessionLeaf(sessionManager, null)) {
			ctx.ui.notify("Restored the empty-root context, but could not reset the branch pointer fully.", "warning");
		}
		return true;
	}

	const originEntry = getSessionEntryById(ctx, originLeafId);
	if (!originEntry) {
		ctx.ui.notify("Origin point is unavailable. Ended planning at the current branch tip.", "warning");
		return true;
	}

	if (isRootUserMessageEntry(originEntry)) {
		const anchorId = getOrCreateRestoreAnchor(ctx, originLeafId, planningLeafId);
		if (!anchorId) {
			ctx.ui.notify(
				"Could not create a restore point for the root message. Ended planning at the current branch tip.",
				"warning",
			);
			return true;
		}

		try {
			const navigateResult = await ctx.navigateTree(anchorId, { summarize: false });
			if (navigateResult.cancelled) {
				ctx.ui.notify("Returning from plan mode was cancelled. Use /plan-md to try again.", "info");
				return false;
			}
		} catch (error) {
			ctx.ui.notify(
				`Failed to restore origin point: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return false;
		}

		const sessionManager = ctx.sessionManager as MutableSessionManager;
		if (!setSessionLeaf(sessionManager, originLeafId)) {
			ctx.ui.notify("Restored the root-message context, but could not reset the branch pointer fully.", "warning");
		}
		return true;
	}

	try {
		const navigateResult = await ctx.navigateTree(originLeafId, { summarize: false });
		if (navigateResult.cancelled) {
			ctx.ui.notify("Returning from plan mode was cancelled. Use /plan-md to try again.", "info");
			return false;
		}
	} catch (error) {
		ctx.ui.notify(
			`Failed to restore origin point: ${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
		return false;
	}

	return true;
}

async function confirmMoveOverwriteIfNeeded(
	ctx: ExtensionContext,
	sourcePath: string | undefined,
	targetPath: string,
): Promise<boolean> {
	if (!sourcePath || sourcePath === targetPath) {
		return true;
	}

	const [sourceExists, targetExists] = await Promise.all([pathExists(sourcePath), pathExists(targetPath)]);
	if (!sourceExists || !targetExists) {
		return true;
	}

	if (!ctx.hasUI) {
		ctx.ui.notify(
			`Refusing to overwrite existing plan file without interactive confirmation: ${targetPath}`,
			"error",
		);
		return false;
	}

	const shouldOverwrite = await ctx.ui.confirm(
		"Overwrite existing plan file?",
		`Target already exists:\n${targetPath}\n\nMove current plan file and overwrite target contents?`,
	);
	if (!shouldOverwrite) {
		ctx.ui.notify("Plan file move cancelled.", "info");
		return false;
	}

	return true;
}

async function updateActivePlanFileLocation(
	ctx: ExtensionContext,
	stateManager: PlanModeStateManager,
	rawLocation: string,
): Promise<{ previousPath: string; nextPath: string } | undefined> {
	const previousPath = resolveActivePlanFilePath(ctx, stateManager.getState().planFilePath);

	let nextPath: string | null;
	try {
		nextPath = await resolvePlanLocationInput(ctx, rawLocation);
	} catch (error) {
		ctx.ui.notify(
			`Failed to resolve plan file location: ${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
		return undefined;
	}

	if (!nextPath) {
		ctx.ui.notify("Please enter a valid plan file location.", "warning");
		return undefined;
	}

	let shouldMove: boolean;
	try {
		shouldMove = await confirmMoveOverwriteIfNeeded(ctx, previousPath, nextPath);
	} catch (error) {
		ctx.ui.notify(
			`Failed to check target path: ${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
		return undefined;
	}
	if (!shouldMove) {
		return undefined;
	}

	try {
		await movePlanFile(previousPath, nextPath);
	} catch (error) {
		ctx.ui.notify(`Failed to move plan file: ${error instanceof Error ? error.message : String(error)}`, "error");
		return undefined;
	}

	const state = stateManager.getState();
	if (state.planFilePath !== nextPath) {
		stateManager.setState(ctx, {
			...state,
			planFilePath: nextPath,
		});
	}

	return {
		previousPath,
		nextPath,
	};
}

async function exitPlanMode(
	ctx: ExtensionContext,
	stateManager: PlanModeStateManager,
	endAction: PlanModeEndAction,
	onPlanModeExited?: (summary: PlanModeExitSummary) => void,
): Promise<boolean> {
	const state = stateManager.getState();
	if (!state.active) {
		ctx.ui.notify("Plan mode is not active.", "info");
		return false;
	}
	if (!ctx.hasUI) {
		ctx.ui.notify("Exiting plan mode requires interactive mode.", "error");
		return false;
	}

	const activeState = state;
	const planningLeafId = ctx.sessionManager.getLeafId();
	const planFilePath = resolveActivePlanFilePath(ctx, activeState.planFilePath);

	if (endAction === "exit") {
		const restoredOrigin = await restorePlanModeOrigin(ctx, activeState.originLeafId, planningLeafId);
		if (!restoredOrigin) {
			return false;
		}
	}

	stateManager.setState(ctx, {
		version: activeState.version,
		active: false,
		planFilePath,
		lastPlanLeafId: planningLeafId ?? activeState.lastPlanLeafId,
	});
	const planText = (await readPlanFile(planFilePath))?.trim();
	if (planText) {
		ctx.ui.setEditorText(buildImplementationPrefill(planFilePath));
	}

	onPlanModeExited?.({
		planFilePath,
		planText,
	});
	return true;
}

async function endPlanMode(
	ctx: ExtensionContext,
	stateManager: PlanModeStateManager,
	onPlanModeExited?: (summary: PlanModeExitSummary) => void,
) {
	const state = stateManager.getState();
	if (!state.active) {
		ctx.ui.notify("Plan mode is not active.", "info");
		return;
	}
	if (!ctx.hasUI) {
		ctx.ui.notify("Exiting plan mode requires interactive mode.", "error");
		return;
	}

	await ctx.waitForIdle();

	const choice = await ctx.ui.select("Plan mode action (Esc stays in Plan mode)", [...PLAN_MODE_END_OPTIONS]);
	if (choice === undefined) {
		ctx.ui.notify("Continuing in Plan mode (Esc).", "info");
		return;
	}

	const endAction: PlanModeEndAction = choice === PLAN_MODE_END_OPTIONS[1] ? "stay-current" : "exit";
	await exitPlanMode(ctx, stateManager, endAction, onPlanModeExited);
}

function canOfferEmptyBranchStart(ctx: ExtensionContext, originLeafId: string | null | undefined): boolean {
	const firstUserMessageId = getFirstUserMessageId(ctx);
	return Boolean(originLeafId && firstUserMessageId && firstUserMessageId !== originLeafId);
}

async function waitForIdleInShortcutContext(ctx: ExtensionContext): Promise<void> {
	while (!ctx.isIdle()) {
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 25);
		});
	}
}

function extractTextFromMessageContent(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}

	let text = "";
	for (const part of content) {
		if (!part || typeof part !== "object") {
			continue;
		}
		const typedPart = part as { type?: unknown; text?: unknown };
		if (typedPart.type === "text" && typeof typedPart.text === "string") {
			text += typedPart.text;
		}
	}
	return text;
}

async function navigateTreeInShortcutContext(
	ctx: ExtensionContext,
	targetId: string,
	options?: {
		summarize?: boolean;
		label?: string;
	},
): Promise<{ cancelled: boolean }> {
	const sessionManager = ctx.sessionManager as MutableSessionManager;

	if (typeof sessionManager.getEntry !== "function") {
		return { cancelled: true };
	}

	const targetEntry = sessionManager.getEntry(targetId);
	if (!targetEntry) {
		return { cancelled: true };
	}

	let newLeafId: string | null = targetId;
	let editorText: string | undefined;

	if (targetEntry.type === "message" && targetEntry.message?.role === "user") {
		newLeafId = targetEntry.parentId ?? null;
		editorText = extractTextFromMessageContent(targetEntry.message.content);
	} else if (targetEntry.type === "custom_message") {
		newLeafId = targetEntry.parentId ?? null;
		editorText = extractTextFromMessageContent(targetEntry.content);
	}

	if (newLeafId === null) {
		if (typeof sessionManager.resetLeaf !== "function") {
			return { cancelled: true };
		}
		sessionManager.resetLeaf();
	} else {
		if (typeof sessionManager.branch !== "function") {
			return { cancelled: true };
		}
		sessionManager.branch(newLeafId);
	}

	if (options?.label && typeof sessionManager.appendLabelChange === "function") {
		sessionManager.appendLabelChange(targetId, options.label);
	}

	if (editorText && ctx.hasUI && !ctx.ui.getEditorText().trim()) {
		ctx.ui.setEditorText(editorText);
	}

	return { cancelled: false };
}

function createShortcutCommandContext(ctx: ExtensionContext): ExtensionCommandContext {
	return {
		...ctx,
		waitForIdle: async () => {
			await waitForIdleInShortcutContext(ctx);
		},
		newSession: async () => ({ cancelled: true }),
		fork: async () => ({ cancelled: true }),
		navigateTree: async (targetId, options) => navigateTreeInShortcutContext(ctx, targetId, options),
		switchSession: async () => ({ cancelled: true }),
		reload: async () => {},
	};
}

export function registerPlanModeCommand(
	pi: ExtensionAPI,
	dependencies: {
		stateManager: PlanModeStateManager;
		onPlanModeExited?: (summary: PlanModeExitSummary) => void;
	},
) {
	const handlePlanModeCommand = async (args: string, ctx: ExtensionCommandContext) => {
		const rawLocation = args.trim();
		const state = dependencies.stateManager.getState();

		if (state.active) {
			if (rawLocation.length > 0) {
				const moved = await updateActivePlanFileLocation(ctx, dependencies.stateManager, rawLocation);
				if (!moved) {
					return;
				}
				if (moved.previousPath === moved.nextPath) {
					ctx.ui.notify("Plan file location unchanged.", "info");
				} else {
					ctx.ui.notify(`Plan file moved to ${moved.nextPath}.`, "info");
				}
				return;
			}

			await endPlanMode(ctx, dependencies.stateManager, dependencies.onPlanModeExited);
			return;
		}

		await ctx.waitForIdle();

		let requestedPlanFilePath: string | undefined;
		if (rawLocation.length > 0) {
			try {
				requestedPlanFilePath = (await resolvePlanLocationInput(ctx, rawLocation)) ?? undefined;
			} catch (error) {
				ctx.ui.notify(
					`Failed to resolve plan file location: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
				return;
			}
			if (!requestedPlanFilePath) {
				ctx.ui.notify("Please provide a valid plan file location.", "warning");
				return;
			}
		}

		const originLeafId = ctx.sessionManager.getLeafId();
		const canStartFromEmptyBranch = canOfferEmptyBranchStart(ctx, originLeafId);
		const currentState = dependencies.stateManager.getState();
		const sessionPlanFilePath = resolveActivePlanFilePath(ctx, currentState.planFilePath);
		const existingSessionPlanText = (await readPlanFile(sessionPlanFilePath))?.trim();
		const savedPlanLeafId = currentState.lastPlanLeafId;
		let planFilePath = requestedPlanFilePath ?? sessionPlanFilePath;

		type StartIntent = "continue" | "empty-branch" | "current-branch";
		let startIntent: StartIntent = existingSessionPlanText ? "continue" : "current-branch";

		if (ctx.hasUI) {
			if (existingSessionPlanText) {
				const continueOption = "Continue planning";
				const startFreshOption = "Start fresh";
				const choices = canStartFromEmptyBranch
					? [continueOption, ...PLAN_MODE_START_OPTIONS]
					: [continueOption, startFreshOption];
				const choice = await ctx.ui.select(`Start planning:\nPlan file: ${sessionPlanFilePath}`, choices);
				if (choice === undefined) {
					ctx.ui.notify("Plan mode activation cancelled.", "info");
					return;
				}
				if (choice === continueOption) {
					startIntent = "continue";
				} else if (choice === PLAN_MODE_START_OPTIONS[0]) {
					startIntent = "empty-branch";
				} else {
					startIntent = "current-branch";
				}
			} else if (canStartFromEmptyBranch) {
				const choice = await ctx.ui.select("Start planning in:", [...PLAN_MODE_START_OPTIONS]);
				if (choice === undefined) {
					ctx.ui.notify("Plan mode activation cancelled.", "info");
					return;
				}
				startIntent = choice === PLAN_MODE_START_OPTIONS[0] ? "empty-branch" : "current-branch";
			}
		}

		if (startIntent === "continue") {
			const resumedSavedPlanningBranch = await navigateToSavedPlanningBranch(ctx, {
				savedLeafId: savedPlanLeafId,
				currentLeafId: originLeafId,
				cancelMessage: "Plan mode activation cancelled.",
			});
			if (!resumedSavedPlanningBranch) {
				return;
			}

			if (requestedPlanFilePath && requestedPlanFilePath !== sessionPlanFilePath) {
				let shouldMove: boolean;
				try {
					shouldMove = await confirmMoveOverwriteIfNeeded(ctx, sessionPlanFilePath, requestedPlanFilePath);
				} catch (error) {
					ctx.ui.notify(
						`Failed to check target path: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
					return;
				}
				if (!shouldMove) {
					return;
				}

				try {
					await movePlanFile(sessionPlanFilePath, requestedPlanFilePath);
					planFilePath = requestedPlanFilePath;
				} catch (error) {
					ctx.ui.notify(
						`Failed to move existing plan file: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
					return;
				}
			} else {
				planFilePath = sessionPlanFilePath;
			}
		} else {
			if (startIntent === "empty-branch") {
				if (!originLeafId) {
					ctx.ui.notify("Could not determine origin point for returning from planning.", "error");
					return;
				}

				const movedToFreshBranch = await navigateToFreshPlanningBranch(ctx, "Plan mode activation cancelled.");
				if (!movedToFreshBranch) {
					return;
				}
			}

			if (requestedPlanFilePath) {
				planFilePath = requestedPlanFilePath;
			} else if (existingSessionPlanText) {
				try {
					planFilePath = await createFreshPlanFilePath(ctx, path.dirname(sessionPlanFilePath));
				} catch (error) {
					ctx.ui.notify(
						`Failed to allocate a fresh plan file path: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
					return;
				}
			} else {
				planFilePath = sessionPlanFilePath;
			}

			if (requestedPlanFilePath) {
				let requestedPathExists = false;
				try {
					requestedPathExists = await pathExists(planFilePath);
				} catch (error) {
					ctx.ui.notify(
						`Failed to check requested plan path: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
					return;
				}

				if (requestedPathExists) {
					if (!ctx.hasUI) {
						ctx.ui.notify(
							`Refusing to overwrite existing plan file without interactive confirmation: ${planFilePath}`,
							"error",
						);
						return;
					}

					const shouldOverwriteRequestedPath = await ctx.ui.confirm(
						"Overwrite existing plan file?",
						`Plan file already exists:\n${planFilePath}\n\nStart fresh planning and overwrite this file?`,
					);
					if (!shouldOverwriteRequestedPath) {
						ctx.ui.notify("Plan mode activation cancelled.", "info");
						return;
					}
				}
			}

			try {
				await resetPlanFile(planFilePath);
			} catch (error) {
				ctx.ui.notify(`Failed to reset plan file: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}
		}

		try {
			await ensurePlanFileExists(planFilePath);
		} catch (error) {
			ctx.ui.notify(
				`Failed to initialize plan file: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return;
		}

		dependencies.stateManager.startPlanMode(ctx, {
			originLeafId,
			planFilePath,
		});
		await sendPlanModePromptMessage(pi);
	};

	pi.registerCommand("plan-md", {
		description: "Start /plan-md, end it, or pass a plan file location.",
		handler: handlePlanModeCommand,
	});

	pi.registerShortcut("alt+p", {
		description: "Toggle /plan-md",
		handler: async (ctx) => {
			const shortcutCommandContext = createShortcutCommandContext(ctx);
			await handlePlanModeCommand("", shortcutCommandContext);
		},
	});
}
