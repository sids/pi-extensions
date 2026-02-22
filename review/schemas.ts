import { Type } from "@sinclair/typebox";

export const ReviewReferenceSchema = Type.Object(
	{
		filePath: Type.String({ description: "Path to the file that contains this finding." }),
		startLine: Type.Integer({ minimum: 1, description: "1-based start line for the referenced range." }),
		endLine: Type.Optional(
			Type.Integer({ minimum: 1, description: "Optional 1-based inclusive end line for the range." }),
		),
	},
	{ additionalProperties: false },
);

export const AddReviewCommentSchema = Type.Object(
	{
		priority: Type.Union([
			Type.Literal("P0"),
			Type.Literal("P1"),
			Type.Literal("P2"),
			Type.Literal("P3"),
		]),
		comment: Type.String({ description: "Concise review finding text." }),
		references: Type.Optional(
			Type.Array(ReviewReferenceSchema, {
				description: "Optional source references for the finding.",
			}),
		),
	},
	{ additionalProperties: false },
);
