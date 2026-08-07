import { describe, expect, test } from "vitest";
import {
	appendInputNeededInstruction,
	hasInputNeededMarker,
	INPUT_NEEDED_INSTRUCTION,
	isHerdrSession,
	parseWaitingForUserInputEvent,
	stripInputNeededMarker,
} from "../utils";

describe("isHerdrSession", () => {
	test("requires the Herdr runtime, socket, and pane environment", () => {
		expect(
			isHerdrSession({
				HERDR_ENV: "1",
				HERDR_SOCKET_PATH: "/tmp/herdr.sock",
				HERDR_PANE_ID: "w1:p1",
			}),
		).toBe(true);
		expect(isHerdrSession({ HERDR_ENV: "1" })).toBe(false);
		expect(
			isHerdrSession({
				HERDR_ENV: "0",
				HERDR_SOCKET_PATH: "/tmp/herdr.sock",
				HERDR_PANE_ID: "w1:p1",
			}),
		).toBe(false);
	});
});

describe("appendInputNeededInstruction", () => {
	test("appends the instruction once", () => {
		const appended = appendInputNeededInstruction("base prompt");
		expect(appended).toBe(`base prompt\n\n${INPUT_NEEDED_INSTRUCTION}`);
		expect(appendInputNeededInstruction(appended)).toBe(appended);
	});
});

describe("hasInputNeededMarker", () => {
	test("requires the marker as the final line", () => {
		expect(hasInputNeededMarker("Please choose one.\n\n:input_needed:")).toBe(true);
		expect(hasInputNeededMarker("Please choose one.\r\n  :input_needed:  \r\n")).toBe(true);
		expect(hasInputNeededMarker("The marker is :input_needed: when input is required.")).toBe(false);
		expect(hasInputNeededMarker(":input_needed:\nAdditional text")).toBe(false);
	});
});

describe("stripInputNeededMarker", () => {
	test("removes complete markers and streaming marker prefixes", () => {
		expect(stripInputNeededMarker("Please choose one.\n\n:input_needed:\n")).toBe("Please choose one.");
		expect(stripInputNeededMarker("Please choose one.\n\n:input_", true)).toBe("Please choose one.");
		expect(stripInputNeededMarker("Please choose one.\n\n:input_", false)).toBe(
			"Please choose one.\n\n:input_",
		);
		expect(stripInputNeededMarker("The marker is :input_needed: when input is required.", true)).toBe(
			"The marker is :input_needed: when input is required.",
		);
	});
});

describe("parseWaitingForUserInputEvent", () => {
	test("parses valid events and rejects incomplete events", () => {
		expect(
			parseWaitingForUserInputEvent({
				source: "plan-md:request_user_input",
				id: "call-1",
				waiting: true,
			}),
		).toEqual({ source: "plan-md:request_user_input", id: "call-1", waiting: true });
		expect(parseWaitingForUserInputEvent({ source: "plan-md", waiting: true })).toBeNull();
		expect(parseWaitingForUserInputEvent(null)).toBeNull();
	});
});
