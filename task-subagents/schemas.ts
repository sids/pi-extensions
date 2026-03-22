import { Type } from "@sinclair/typebox";

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
			description: "One or more tasks to run via isolated research subagents.",
		}),
		concurrency: Type.Optional(
			Type.Integer({
				minimum: 1,
				maximum: 4,
				description: "How many tasks to run in parallel (default: 2).",
			}),
		),
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
