import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "typebox";
import { SUBAGENT_CONTEXT_MODES, SUBAGENT_TOOL_THINKING_LEVELS } from "./types";

const SubagentToolThinkingLevelSchema = StringEnum(SUBAGENT_TOOL_THINKING_LEVELS, {
	description:
		"Optional default thinking level for launched subagents. Must be one of off, minimal, low, medium, high, or xhigh. Defaults to the current thinking level.",
});

const SubagentContextSchema = StringEnum(SUBAGENT_CONTEXT_MODES, {
	description:
		"Optional session context mode for launched subagents. Use fresh (default) for a clean ephemeral run, or fork to fork from the current session.",
});

export const SubagentTaskSchema = Type.Object(
	{
		id: Type.Optional(
			Type.String({
				description: "Optional stable task ID (e.g. auth-scan) for tracing and steering.",
			}),
		),
		prompt: Type.String({ description: "Task prompt for the delegated subagent." }),
		cwd: Type.Optional(Type.String({ description: "Optional working directory for this task." })),
	},
	{ additionalProperties: false },
);

export const SubagentsSchema = Type.Object(
	{
		tasks: Type.Array(SubagentTaskSchema, {
			minItems: 1,
			maxItems: 6,
			description:
				"One or more tasks to run via isolated research subagents. Prefer batching related tasks into this single array instead of making multiple subagents calls.",
		}),
		concurrency: Type.Optional(
			Type.Integer({
				minimum: 1,
				maximum: 4,
				description: "How many tasks to run in parallel (default: 2).",
			}),
		),
		thinking_level: Type.Optional(SubagentToolThinkingLevelSchema),
		context: Type.Optional(SubagentContextSchema),
	},
	{ additionalProperties: false },
);

export const SteerSubagentSchema = Type.Object(
	{
		runId: Type.String({ description: "Run ID from a previous subagents result." }),
		taskId: Type.String({ description: "Task ID from that run to rerun with steering." }),
		instruction: Type.String({ description: "Additional steering instruction for the selected task." }),
	},
	{ additionalProperties: false },
);
