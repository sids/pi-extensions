import { describe, expect, test } from "bun:test";
import { ensureCollapsedStateForOverallComments } from "../web/overall-comments";

describe("ensureCollapsedStateForOverallComments", () => {
	test("collapses overall comments by default", () => {
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
