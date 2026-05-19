import { describe, expect, test } from "vitest";
import { ensureCollapsedStateForOverallComments } from "../web/overall-comments";

describe("ensureCollapsedStateForOverallComments", () => {
	test("keeps empty overall comments expanded by default", () => {
		expect(
			ensureCollapsedStateForOverallComments(
				{},
				[
					{
						id: "overall-1",
						kind: "overall",
						text: "",
						createdAt: 1,
						updatedAt: 1,
						sentAt: null,
					},
				],
			),
		).toEqual({ "overall-1": false });
	});

	test("collapses non-empty overall comments by default", () => {
		expect(
			ensureCollapsedStateForOverallComments(
				{},
				[
					{
						id: "overall-1",
						kind: "overall",
						text: "Looks good.",
						createdAt: 1,
						updatedAt: 1,
						sentAt: null,
					},
				],
			),
		).toEqual({ "overall-1": true });
	});

	test("keeps explicit collapse state for overall comments", () => {
		expect(
			ensureCollapsedStateForOverallComments(
				{ "overall-1": false },
				[
					{
						id: "overall-1",
						kind: "overall",
						text: "",
						createdAt: 1,
						updatedAt: 1,
						sentAt: null,
					},
				],
			),
		).toEqual({ "overall-1": false });
	});
});
