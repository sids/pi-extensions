import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { keyHint, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { PLAN_MODE_PROMPT_ENTRY_TYPE, registerPlanModeCommand } from "./flow";
import { resolveActivePlanFilePath } from "./plan-files";
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

const PLAN_MODE_EXIT_ENTRY_TYPE = "plan-md:exit";

export default function (pi: ExtensionAPI) {
	const stateManager = createPlanModeStateManager(pi);

	pi.registerMessageRenderer(PLAN_MODE_PROMPT_ENTRY_TYPE, (message, { expanded }, theme) => {
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

		const render = (text: string) => new Text(text, 1, 0, (segment) => theme.bg("customMessageBg", segment));
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

	pi.registerMessageRenderer(PLAN_MODE_EXIT_ENTRY_TYPE, (message, { expanded }, theme) => {
		const render = (text: string) => new Text(text, 1, 0, (segment) => theme.bg("customMessageBg", segment));
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
			"Overwrite the plan file with the full latest plan text. Call this whenever the plan changes so the plan file stays canonical.",
		promptSnippet: "Overwrite the current plan file with the latest full plan text.",
		parameters: SetPlanSchema,
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

			if (!expanded) {
				return new Text(
					`${theme.fg("success", "Plan written.")}\n${theme.fg("dim", keyHint("app.tools.expand", "to view plan"))}`,
					0,
					0,
				);
			}

			return new Text(`${theme.fg("success", "Plan written.")}\n${details.plan}`, 0, 0);
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

			if (stateManager.getState().planFilePath !== planFilePath) {
				stateManager.setState(ctx, {
					...stateManager.getState(),
					planFilePath,
				});
			}
			return {
				content: [{ type: "text", text: "Plan written." }],
				details: {
					plan,
				},
			};
		},
	});

	registerRequestUserInputTool(pi, {
		getState: stateManager.getState,
		requestUserInputSchema: RequestUserInputSchema,
	});

	registerPlanModeCommand(pi, {
		stateManager,
		onPlanModeExited: ({ planFilePath, planText }) => {
			pi.sendMessage({
				customType: PLAN_MODE_EXIT_ENTRY_TYPE,
				content: "Plan mode ended.",
				display: true,
				details: {
					planFilePath,
					planText,
				},
			});
		},
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

	pi.on("session_start", async (_event, ctx) => {
		stateManager.refresh(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		stateManager.refresh(ctx);
	});
}
