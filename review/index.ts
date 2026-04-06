import { keyHint, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Box, Text } from "@mariozechner/pi-tui";
import { registerAddReviewCommentTool } from "./comments";
import {
	registerReviewCommand,
	REVIEW_PROMPT_ENTRY_TYPE,
	REVIEW_SUMMARY_ENTRY_TYPE,
	type ReviewPromptDetails,
} from "./flow";
import { AddReviewCommentSchema } from "./schemas";
import { CONTEXT_ENTRY_TYPE, createReviewModeStateManager } from "./state";

export default function (pi: ExtensionAPI) {
	const stateManager = createReviewModeStateManager(pi);

	pi.registerMessageRenderer(REVIEW_SUMMARY_ENTRY_TYPE, (message, _options, theme) => {
		const box = new Box(1, 0, (segment) => theme.bg("customMessageBg", segment));
		box.addChild(new Text(String(message.content ?? ""), 0, 0));
		return box;
	});

	pi.registerMessageRenderer(REVIEW_PROMPT_ENTRY_TYPE, (message, { expanded }, theme) => {
		const renderInMessageBox = (text: string) => {
			const box = new Box(1, 0, (segment) => theme.bg("customMessageBg", segment));
			box.addChild(new Text(text, 0, 0));
			return box;
		};

		const details = message.details as ReviewPromptDetails | undefined;
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

	registerReviewCommand(pi, {
		stateManager,
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

	pi.on("session_start", async (_event, ctx) => {
		stateManager.refresh(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		stateManager.refresh(ctx);
	});
}
