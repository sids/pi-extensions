import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { keyHint, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { isTuiMode } from "@siddr/pi-shared-qna/extension-mode";
import {
	handlePlannotatorDecision,
	registerPlannotatorFeedbackRenderer,
} from "@siddr/pi-shared-qna/plannotator-feedback";
import { exitPlanMode, PLAN_MODE_PROMPT_ENTRY_TYPE, registerPlanModeCommand } from "./flow";
import { resolveActivePlanFilePath } from "./plan-files";
import { reviewPlanInBrowser } from "./plan-review";
import { loadPlanModePrompt } from "./prompts";
import { registerRequestUserInputTool } from "./request-user-input";
import { RequestUserInputSchema, SetPlanSchema } from "./schemas";
import { CONTEXT_ENTRY_TYPE, createPlanModeStateManager } from "./state";

function summarizeSnippet(text: string, maxLength: number = 120): string {
	const singleLine = text.replace(/\s+/g, " ").trim();
	if (!singleLine) {
		return "";
	}
	if (singleLine.length <= maxLength) {
		return singleLine;
	}
	return `${singleLine.slice(0, maxLength - 3)}...`;
}

interface SetPlanDetails {
	plan: string;
}

interface PlanModeExitDetails {
	planFilePath: string;
	planText?: string;
}

interface PlanModePromptDetails {
	activationId?: string;
	instructionsPrompt: string;
}

interface PendingPlanReview {
	planFilePath: string;
	plan: string;
	sessionId: string;
	scheduled: boolean;
}

type SchedulePlanReview = (review: () => Promise<void>) => void;

const PLAN_MODE_EXIT_ENTRY_TYPE = "plan-md:exit";

export type PlanMdExtensionDependencies = {
	reviewPlanInBrowser: typeof reviewPlanInBrowser;
	schedulePlanReview: SchedulePlanReview;
};

function schedulePlanReview(review: () => Promise<void>): void {
	setTimeout(() => {
		void review();
	}, 0);
}

export default function (pi: ExtensionAPI, overrides: Partial<PlanMdExtensionDependencies> = {}) {
	const dependencies = { reviewPlanInBrowser, schedulePlanReview, ...overrides } satisfies PlanMdExtensionDependencies;
	const stateManager = createPlanModeStateManager(pi);
	let pendingPlanReview: PendingPlanReview | undefined;
	const onPlanModeExited = ({ planFilePath, planText }: PlanModeExitDetails) => {
		pendingPlanReview = undefined;
		pi.sendMessage({
			customType: PLAN_MODE_EXIT_ENTRY_TYPE,
			content: "Plan mode ended.",
			display: true,
			details: {
				planFilePath,
				planText,
			},
		});
	};
	const isCurrentPlanReview = (ctx: ExtensionContext, review: PendingPlanReview) => {
		const state = stateManager.getState();
		return pendingPlanReview === review
			&& state.active
			&& state.planFilePath === review.planFilePath
			&& ctx.sessionManager.getSessionId() === review.sessionId;
	};
	const runPlanReview = async (ctx: ExtensionContext, pendingReview: PendingPlanReview) => {
		try {
			if (!isCurrentPlanReview(ctx, pendingReview)) {
				return;
			}

			const review = await dependencies.reviewPlanInBrowser(ctx, pendingReview.plan);
			if (!isCurrentPlanReview(ctx, pendingReview)) {
				return;
			}

			const decision = !review.approved && !review.feedback?.trim()
				? { ...review, feedback: "Plan rejected. Please revise it." }
				: review;
			await handlePlannotatorDecision(pi, ctx, decision, {
				onApproved: async (feedback) => {
					stateManager.setState(ctx, {
						...stateManager.getState(),
						approvalFeedback: feedback,
					});
					await exitPlanMode(ctx, stateManager, "stay-current", onPlanModeExited);
				},
			});
		} catch (error) {
			if (isCurrentPlanReview(ctx, pendingReview)) {
				const message = error instanceof Error ? error.message : "Failed to open plan review.";
				ctx.ui.notify(message, "error");
			}
		}
	};
	const schedulePendingPlanReview = (ctx: ExtensionContext) => {
		const review = pendingPlanReview;
		if (!review || review.scheduled) {
			return;
		}
		review.scheduled = true;
		dependencies.schedulePlanReview(() => runPlanReview(ctx, review));
	};

	registerPlannotatorFeedbackRenderer(pi);
	pi.registerMessageRenderer(PLAN_MODE_PROMPT_ENTRY_TYPE, (message, { expanded, outputPad }, theme) => {
		const state = stateManager.getState();
		const details = message.details as PlanModePromptDetails | undefined;
		if (!state.active) {
			return undefined;
		}
		if (state.activationId) {
			if (details?.activationId !== state.activationId) {
				return undefined;
			}
		} else if (details?.activationId !== undefined) {
			return undefined;
		}

		const render = (text: string) => new Text(text, outputPad, 0, (segment) => theme.bg("customMessageBg", segment));
		const prompt = details?.instructionsPrompt ?? String(message.content ?? "");

		if (!expanded) {
			const allPromptLines = prompt.split("\n");
			const previewLineCount = 8;
			const previewLines = allPromptLines.slice(0, previewLineCount);
			const lines = [...previewLines];
			if (allPromptLines.length > previewLineCount) {
				lines.push(theme.fg("dim", "..."));
			}
			lines.push(keyHint("app.tools.expand", "to expand"));
			return render(lines.join("\n"));
		}

		return render(prompt);
	});

	pi.registerMessageRenderer(PLAN_MODE_EXIT_ENTRY_TYPE, (message, { expanded, outputPad }, theme) => {
		const render = (text: string) => new Text(text, outputPad, 0, (segment) => theme.bg("customMessageBg", segment));
		const details = message.details as PlanModeExitDetails | undefined;
		const title = String(message.content || "Plan mode ended.");
		const lines = [theme.fg("accent", theme.bold(title))];

		if (!details?.planFilePath) {
			return render(lines.join("\n"));
		}

		if (!details.planText?.trim()) {
			lines.push(theme.fg("warning", "No plan created."));
			return render(lines.join("\n"));
		}

		lines.push(theme.fg("muted", `Plan file: ${details.planFilePath}`));
		if (!expanded) {
			lines.push(theme.fg("dim", keyHint("app.tools.expand", "to expand")));
			return render(lines.join("\n"));
		}

		lines.push("");
		lines.push(details.planText);
		return render(lines.join("\n"));
	});

	pi.registerTool({
		name: "set_plan",
		label: "set_plan",
		description:
			"Persist the full latest implementation plan and queue browser review for after the current turn when the request calls for creating or revising one.",
		promptSnippet: "Persist a complete implementation plan for browser review after the current turn.",
		promptGuidelines: [
			"Use set_plan only when the current request calls for creating or revising a concrete implementation plan. After calling it, finish the response and wait for browser review; if review requests changes, revise the plan and call set_plan again.",
		],
		parameters: SetPlanSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		renderCall(args, theme) {
			const preview = summarizeSnippet(String(args.plan ?? ""), 90);
			return new Text(
				`${theme.fg("toolTitle", theme.bold("set_plan "))}${theme.fg("muted", preview || "(empty)")}`,
				0,
				0,
			);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) {
				return new Text(theme.fg("muted", "Writing plan..."), 0, 0);
			}

			const details = result.details as SetPlanDetails | undefined;
			if (!details?.plan) {
				const text = result.content.find((item) => item.type === "text");
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const status = theme.fg("success", "Plan written.");
			if (!expanded) {
				return new Text(
					`${status}\n${theme.fg("dim", keyHint("app.tools.expand", "to view plan"))}`,
					0,
					0,
				);
			}

			return new Text(`${status}\n${details.plan}`, 0, 0);
		},
		async execute(_toolCallId, params: { plan: string }, _signal, _onUpdate, ctx): Promise<AgentToolResult<SetPlanDetails>> {
			if (!stateManager.getState().active) {
				throw new Error("set_plan is only available while plan mode is active.");
			}

			const planFilePath = resolveActivePlanFilePath(ctx, stateManager.getState().planFilePath);
			if (!planFilePath) {
				throw new Error("No active plan file. Restart plan mode and try again.");
			}

			const plan = String(params.plan ?? "").trim();
			if (!plan) {
				throw new Error("set_plan requires non-empty plan text.");
			}

			await mkdir(path.dirname(planFilePath), { recursive: true });
			await writeFile(planFilePath, `${plan}\n`, "utf8");

			stateManager.setState(ctx, {
				...stateManager.getState(),
				planFilePath,
				approvalFeedback: undefined,
			});

			pendingPlanReview = undefined;
			if (!isTuiMode(ctx)) {
				return {
					content: [{ type: "text", text: "Plan written. Browser review is only available in TUI mode." }],
					details: { plan },
				};
			}

			pendingPlanReview = {
				planFilePath,
				plan,
				sessionId: ctx.sessionManager.getSessionId(),
				scheduled: false,
			};
			return {
				content: [{
					type: "text",
					text: "Plan written. Finish this response; browser review will open after the turn ends.",
				}],
				details: { plan },
			};
		},
	});

	registerRequestUserInputTool(pi, {
		getState: stateManager.getState,
		requestUserInputSchema: RequestUserInputSchema,
	});

	registerPlanModeCommand(pi, {
		stateManager,
		onPlanModeExited,
	});

	pi.on("agent_settled", (_event, ctx) => {
		schedulePendingPlanReview(ctx);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		stateManager.syncTools();
		const state = stateManager.getState();
		if (!state.active || state.promptPending === false) {
			return;
		}

		stateManager.setState(ctx, {
			...state,
			promptPending: false,
		});

		const prompt = await loadPlanModePrompt();
		return {
			message: {
				customType: CONTEXT_ENTRY_TYPE,
				content: prompt,
				display: false,
			},
		};
	});

	pi.on("session_compact", async (_event, ctx) => {
		const state = stateManager.getState();
		if (!state.active || state.promptPending) {
			return;
		}

		stateManager.setState(ctx, {
			...state,
			promptPending: true,
		});

		const prompt = await loadPlanModePrompt();
		pi.sendMessage({
			customType: PLAN_MODE_PROMPT_ENTRY_TYPE,
			content: "Plan mode instructions",
			display: true,
			details: {
				activationId: state.activationId,
				instructionsPrompt: prompt,
			},
		});
	});

	pi.on("session_start", (_event, ctx) => {
		stateManager.refresh(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		stateManager.refresh(ctx);
	});
}
