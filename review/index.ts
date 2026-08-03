import { fileURLToPath } from "node:url";
import { keyHint, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { getReviewCommentsForRun, registerAddReviewCommentTool } from "./comments";
import {
	registerReviewCommand,
	REVIEW_CHANGE_SUMMARY_ENTRY_TYPE,
	REVIEW_PROMPT_ENTRY_TYPE,
	REVIEW_SUMMARY_ENTRY_TYPE,
	type ReviewPromptDetails,
} from "./flow";
import { ReviewLifecycleController } from "./lifecycle";
import { AddReviewCommentSchema } from "./schemas";
import { resolveReviewCommandName, startReviewFromShortcut } from "./shortcut";
import { CONTEXT_ENTRY_TYPE, createReviewModeStateManager } from "./state";
import { runReviewTriageWithCountdown } from "./triage-tui";

export default function (pi: ExtensionAPI) {
	const stateManager = createReviewModeStateManager(pi);
	const lifecycle = new ReviewLifecycleController();

	pi.registerMessageRenderer(REVIEW_SUMMARY_ENTRY_TYPE, (message, _options, theme) => {
		const box = new Box(1, 0, (segment) => theme.bg("customMessageBg", segment));
		box.addChild(new Text(String(message.content ?? ""), 0, 0));
		return box;
	});

	pi.registerMessageRenderer(REVIEW_CHANGE_SUMMARY_ENTRY_TYPE, (message, { expanded }, theme) => {
		const renderInMessageBox = (text: string) => {
			const box = new Box(1, 0, (segment) => theme.bg("customMessageBg", segment));
			box.addChild(new Text(text, 0, 0));
			return box;
		};

		const summary = String(message.content ?? "");
		if (expanded) {
			return renderInMessageBox(summary);
		}

		const allSummaryLines = summary.split("\n");
		const previewLineCount = 4;
		const previewLines = allSummaryLines.slice(0, previewLineCount);
		const lines = [...previewLines];
		if (allSummaryLines.length > previewLineCount) {
			lines.push(theme.fg("dim", "..."));
		}
		lines.push(keyHint("app.tools.expand", "to expand"));
		return renderInMessageBox(lines.join("\n"));
	});

	pi.registerMessageRenderer(REVIEW_PROMPT_ENTRY_TYPE, (message, { expanded }, theme) => {
		const state = stateManager.getState();
		const details = message.details as ReviewPromptDetails | undefined;
		if (!state.active) {
			return undefined;
		}
		if (state.runId) {
			if (details?.runId !== state.runId) {
				return undefined;
			}
		} else if (details?.runId !== undefined) {
			return undefined;
		}

		const renderInMessageBox = (text: string) => {
			const box = new Box(1, 0, (segment) => theme.bg("customMessageBg", segment));
			box.addChild(new Text(text, 0, 0));
			return box;
		};

		if (!details) {
			return renderInMessageBox(String(message.content ?? ""));
		}

		if (!expanded) {
			const allPromptLines = details.instructionsPrompt.split("\n");
			const previewLineCount = 8;
			const previewLines = allPromptLines.slice(0, previewLineCount);
			const lines = [...previewLines];
			if (allPromptLines.length > previewLineCount) {
				lines.push(theme.fg("dim", "..."));
			}
			lines.push(keyHint("app.tools.expand", "to expand"));
			return renderInMessageBox(lines.join("\n"));
		}

		return renderInMessageBox(details.instructionsPrompt);
	});

	registerAddReviewCommentTool(pi, {
		getState: stateManager.getState,
		addReviewCommentSchema: AddReviewCommentSchema,
	});

	const reviewCommand = registerReviewCommand(pi, {
		stateManager,
		flow: {
			setLifecyclePhase: (phase, runId) => lifecycle.setPhase(phase, runId),
		},
	});

	pi.registerShortcut("ctrl+alt+r", {
		description: "Start review",
		handler: async (ctx) => {
			if (stateManager.getState().active) {
				ctx.ui.notify("Review mode is already active. Use /review to exit.", "info");
				return;
			}
			const commandName = resolveReviewCommandName(pi.getCommands(), fileURLToPath(import.meta.url));
			if (!commandName) {
				ctx.ui.notify("Ctrl+Alt+R could not resolve the review command.", "warning");
				return;
			}
			await startReviewFromShortcut(ctx, commandName);
		},
	});

	pi.on("before_agent_start", async () => {
		stateManager.syncTools();
		const state = stateManager.getState();
		if (!state.active) {
			return;
		}

		const prompt = state.reviewInstructionsPrompt?.trim();
		const content = prompt
			? `[REVIEW MODE ACTIVE]\n\n${prompt}`
			: "[REVIEW MODE ACTIVE]\nFocus on collecting findings. Use add_review_comment exactly once per actionable finding with priority P0-P3 and precise references.";

		return {
			message: {
				customType: CONTEXT_ENTRY_TYPE,
				content,
				display: false,
			},
		};
	});

	pi.on("agent_start", async () => {
		const state = stateManager.getState();
		if (!state.active || !state.runId) {
			return;
		}
		lifecycle.markAgentStarted(state.runId);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const state = stateManager.getState();
		if (
			ctx.mode !== "tui"
			|| !state.active
			|| !state.runId
			|| !lifecycle.beginAutoExit(state.runId)
		) {
			return;
		}

		setTimeout(() => {
			void (async () => {
				const latestState = stateManager.getState();
				if (!latestState.active || latestState.runId !== state.runId) {
					lifecycle.restore(latestState.active, latestState.runId);
					return;
				}

				const comments = getReviewCommentsForRun(ctx, state.runId);
				const triageResult = await runReviewTriageWithCountdown(ctx, comments, state.targetHint);
				if (!triageResult) {
					lifecycle.setPhase("reviewing", state.runId);
					ctx.ui.notify("Review mode end cancelled. Continuing review mode.", "info");
					return;
				}

				const result = await reviewCommand.endAutomatically(state.runId, triageResult);
				if (result === "ended") {
					return;
				}
				const currentState = stateManager.getState();
				lifecycle.restore(currentState.active, currentState.runId);
				if (result === "unavailable" && currentState.active && currentState.runId === state.runId) {
					ctx.ui.setEditorText("/review");
					ctx.ui.notify(
						"Review triage is complete. Press Enter to return to the original branch.",
						"warning",
					);
				}
			})().catch((error) => {
				const latestState = stateManager.getState();
				lifecycle.restore(latestState.active, latestState.runId);
				ctx.ui.notify(
					`Automatic review exit failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			});
		}, 0);
	});

	pi.on("session_start", async (_event, ctx) => {
		stateManager.refresh(ctx);
		const state = stateManager.getState();
		lifecycle.restore(state.active, state.runId);
	});

	pi.on("session_tree", async (_event, ctx) => {
		stateManager.refresh(ctx);
	});
}
