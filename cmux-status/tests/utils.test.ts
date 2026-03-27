import { describe, expect, test } from "bun:test";
import {
	areCmuxStatusPresentationsEqual,
	formatCmuxStatusKey,
	formatCmuxStatusText,
	getCmuxStatusOwnerId,
	getCmuxStatusPresentation,
	getCmuxWorkspaceId,
	parseCmuxStatusList,
} from "../utils";

describe("getCmuxWorkspaceId", () => {
	test("returns the current workspace id when present", () => {
		expect(getCmuxWorkspaceId({ CMUX_WORKSPACE_ID: "workspace:1" })).toBe("workspace:1");
	});

	test("returns null for missing or blank values", () => {
		expect(getCmuxWorkspaceId({})).toBeNull();
		expect(getCmuxWorkspaceId({ CMUX_WORKSPACE_ID: "   " })).toBeNull();
	});
});

describe("getCmuxStatusOwnerId", () => {
	test("uses both surface and panel ids when present", () => {
		expect(getCmuxStatusOwnerId({ CMUX_SURFACE_ID: "surface:1", CMUX_PANEL_ID: "panel:1" })).toBe(
			"surface:surface:1:panel:panel:1",
		);
	});

	test("returns null when neither surface nor panel id is present", () => {
		expect(getCmuxStatusOwnerId({})).toBeNull();
	});
});

describe("formatCmuxStatusKey", () => {
	test("uses an owner-specific key when an owner is available", () => {
		expect(formatCmuxStatusKey("surface:surface:1:panel:panel:1")).toBe(
			"pi-cmux-status:surface:surface:1:panel:panel:1",
		);
	});

	test("uses the shared key only when no owner is provided", () => {
		expect(formatCmuxStatusKey()).toBe("pi-cmux-status");
	});
});

describe("formatCmuxStatusText", () => {
	test("formats named sessions", () => {
		expect(formatCmuxStatusText("build", "Working")).toBe("π build: Working");
	});

	test("formats unnamed sessions", () => {
		expect(formatCmuxStatusText(undefined, "Ready")).toBe("π - Ready");
	});
});

describe("getCmuxStatusPresentation", () => {
	test("adds fixed icons for Ready, Waiting, and Error", () => {
		expect(getCmuxStatusPresentation("build", "Ready")).toMatchObject({
			text: "π build: Ready",
			icon: "checkmark",
		});
		expect(getCmuxStatusPresentation("build", "Waiting")).toMatchObject({
			text: "π build: Waiting",
			icon: "hourglass",
		});
		expect(getCmuxStatusPresentation(undefined, "Error")).toMatchObject({
			text: "π - Error",
			icon: "exclamationmark.triangle.fill",
		});
	});

	test("cycles Working text prefixes by animation frame", () => {
		const first = getCmuxStatusPresentation(undefined, "Working", 0);
		const second = getCmuxStatusPresentation(undefined, "Working", 1);
		const third = getCmuxStatusPresentation(undefined, "Working", 2);
		const wrapped = getCmuxStatusPresentation(undefined, "Working", 10);

		expect(first.text).toBe("⠋ π - Working");
		expect(first.icon).toBeNull();
		expect(first.text).not.toBe(second.text);
		expect(second.text).not.toBe(third.text);
		expect(wrapped.text).toBe(first.text);
	});
});

describe("areCmuxStatusPresentationsEqual", () => {
	test("compares text, icon, and color", () => {
		expect(
			areCmuxStatusPresentationsEqual(
				getCmuxStatusPresentation(undefined, "Working", 0),
				getCmuxStatusPresentation(undefined, "Working", 0),
			),
		).toBeTrue();
		expect(
			areCmuxStatusPresentationsEqual(
				getCmuxStatusPresentation(undefined, "Working", 0),
				getCmuxStatusPresentation(undefined, "Working", 1),
			),
		).toBeFalse();
	});
});


describe("parseCmuxStatusList", () => {
	test("parses top-level status arrays", () => {
		expect(
			Array.from(
				parseCmuxStatusList(
					JSON.stringify([
						{ key: "pi-cmux-status", value: "π - Ready" },
						{ key: "build", text: "Working" },
					]),
				).entries(),
			),
		).toEqual([
			["pi-cmux-status", "π - Ready"],
			["build", "Working"],
		]);
	});

	test("parses nested status arrays", () => {
		expect(
			Array.from(
				parseCmuxStatusList(
					JSON.stringify({
						result: {
							statuses: [{ key: "pi-cmux-status:build", statusText: "π build: Waiting" }],
						},
					}),
				).entries(),
			),
		).toEqual([["pi-cmux-status:build", "π build: Waiting"]]);
	});

	test("parses simple line-based status output", () => {
		expect(
			Array.from(parseCmuxStatusList("pi-cmux-status=π - Ready\npi-cmux-status:build=π build: Waiting").entries()),
		).toEqual([
			["pi-cmux-status", "π - Ready"],
			["pi-cmux-status:build", "π build: Waiting"],
		]);
	});

	test("parses structured line-based status output with icon metadata", () => {
		expect(
			Array.from(
				parseCmuxStatusList(
					"key=pi-cmux-status value=π - Working icon=ellipsis\nkey=pi-cmux-status:build value=π build: Waiting icon=hourglass",
				).entries(),
			),
		).toEqual([
			["pi-cmux-status", "π - Working"],
			["pi-cmux-status:build", "π build: Waiting"],
		]);
	});

	test("parses real cmux line output where icon metadata trails the value", () => {
		expect(
			Array.from(
				parseCmuxStatusList(
					"pi-cmux-status:cmux-status=π cmux-status: Working icon=ellipsis\npi-cmux-status=π - Ready\npi-cmux-status:build=π build: Waiting icon=hourglass",
				).entries(),
			),
		).toEqual([
			["pi-cmux-status:cmux-status", "π cmux-status: Working"],
			["pi-cmux-status", "π - Ready"],
			["pi-cmux-status:build", "π build: Waiting"],
		]);
	});

	test("returns an empty map for invalid input", () => {
		expect(Array.from(parseCmuxStatusList("not json").entries())).toEqual([]);
	});
});
