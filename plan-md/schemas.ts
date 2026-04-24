import { Type } from "typebox";

export const SetPlanSchema = Type.Object(
	{
		plan: Type.String({
			description:
				"Full plan document text. This overwrites the current plan file and should include the complete latest plan.",
		}),
	},
	{ additionalProperties: false },
);

export const RequestUserInputOptionSchema = Type.Object(
	{
		label: Type.String({ description: "User-facing label (1-5 words)." }),
		description: Type.String({ description: "One short sentence explaining impact/tradeoff if selected." }),
	},
	{ additionalProperties: false },
);

export const RequestUserInputQuestionSchema = Type.Object(
	{
		id: Type.String({ description: "Stable identifier for mapping answers (snake_case)." }),
		header: Type.String({ description: "Short header label shown in the UI (12 or fewer chars)." }),
		question: Type.String({ description: "Single-sentence prompt shown to the user." }),
		options: Type.Optional(
			Type.Array(RequestUserInputOptionSchema, {
				description:
					'Optional multiple-choice options. When omitted or empty, the question is treated as open-ended and accepts freeform input.',
			}),
		),
	},
	{ additionalProperties: false },
);

export const RequestUserInputSchema = Type.Object(
	{
		questions: Type.Array(RequestUserInputQuestionSchema, {
			minItems: 1,
			description: "Questions to show the user.",
		}),
	},
	{ additionalProperties: false },
);
