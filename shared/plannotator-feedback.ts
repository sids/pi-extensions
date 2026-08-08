import {
	getMarkdownTheme,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";

export const PLANNOTATOR_FEEDBACK_MESSAGE_TYPE = "siddr:plannotator-feedback";

export type PlannotatorDecision = {
	feedback?: string;
	exit?: boolean;
	approved?: boolean;
};

export type PlannotatorDecisionOptions = {
	notifications?: {
		approved?: string;
		closed?: string;
		empty?: string;
		sent?: string;
	};
	onApproved?: (feedback: string) => void | Promise<void>;
};

export function formatPlannotatorFeedbackForPi(feedback: string): string {
	return feedback
		.split(/\r?\n/u)
		.map((line) => line.replace(/^(\s*)>\s?/u, "$1"))
		.join("\n")
		.trim();
}

export function registerPlannotatorFeedbackRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer(PLANNOTATOR_FEEDBACK_MESSAGE_TYPE, (message, { outputPad }, theme) => {
		const displayText = formatPlannotatorFeedbackForPi(String(message.content ?? ""));
		const markdown = new Markdown(displayText, outputPad, 0, getMarkdownTheme());
		return {
			render(width: number) {
				return markdown.render(width).map((line) => theme.bg("customMessageBg", line));
			},
			invalidate() {
				markdown.invalidate();
			},
		};
	});
}

function sendFeedback(pi: ExtensionAPI, ctx: ExtensionContext, feedback: string): void {
	const message = {
		customType: PLANNOTATOR_FEEDBACK_MESSAGE_TYPE,
		content: feedback,
		display: true,
	};
	pi.sendMessage(
		message,
		ctx.isIdle() ? { triggerTurn: true } : { deliverAs: "followUp" },
	);
}

function notify(ctx: ExtensionContext, message: string | undefined): void {
	if (message && ctx.hasUI) {
		ctx.ui.notify(message, "info");
	}
}

export async function handlePlannotatorDecision(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	decision: PlannotatorDecision,
	options: PlannotatorDecisionOptions = {},
): Promise<void> {
	const feedback = decision.feedback?.trim() ?? "";
	if (decision.exit) {
		notify(ctx, options.notifications?.closed);
		return;
	}
	if (decision.approved) {
		await options.onApproved?.(feedback);
		notify(ctx, options.notifications?.approved);
		return;
	}
	if (!feedback) {
		notify(ctx, options.notifications?.empty);
		return;
	}

	sendFeedback(pi, ctx, feedback);
	notify(ctx, options.notifications?.sent);
}
