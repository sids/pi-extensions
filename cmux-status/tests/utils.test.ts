import { describe, expect, test } from "bun:test";
import {
	formatCmuxStatusKey,
	formatCmuxStatusText,
	getCmuxStatusPriority,
	getCmuxWorkspaceId,
	parseCmuxStatusList,
	parseManagedCmuxStatusText,
	shouldOverwriteCmuxStatus,
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

describe("formatCmuxStatusKey", () => {
	test("uses a per-session key for named sessions", () => {
		expect(formatCmuxStatusKey("build")).toBe("pi-cmux-status:build");
	});

	test("uses the shared key for unnamed sessions", () => {
		expect(formatCmuxStatusKey(undefined)).toBe("pi-cmux-status");
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

describe("parseManagedCmuxStatusText", () => {
	test("parses named and unnamed session texts", () => {
		expect(parseManagedCmuxStatusText("π build: Waiting")).toEqual({ status: "Waiting" });
		expect(parseManagedCmuxStatusText("π - Error")).toEqual({ status: "Error" });
	});

	test("ignores unrelated texts", () => {
		expect(parseManagedCmuxStatusText("Build running")).toBeNull();
	});
});

describe("getCmuxStatusPriority", () => {
	test("orders statuses by severity", () => {
		expect(getCmuxStatusPriority("Error")).toBeGreaterThan(getCmuxStatusPriority("Waiting"));
		expect(getCmuxStatusPriority("Waiting")).toBeGreaterThan(getCmuxStatusPriority("Working"));
		expect(getCmuxStatusPriority("Working")).toBeGreaterThan(getCmuxStatusPriority("Ready"));
	});
});

describe("shouldOverwriteCmuxStatus", () => {
	test("always overwrites when the current value matches the last written value", () => {
		expect(shouldOverwriteCmuxStatus("π mine: Working", "π mine: Working", "π mine: Ready")).toBeTrue();
	});

	test("overwrites empty status", () => {
		expect(shouldOverwriteCmuxStatus(null, null, "π - Ready")).toBeTrue();
	});

	test("requires higher priority to replace another surface", () => {
		expect(shouldOverwriteCmuxStatus("π other: Waiting", "π mine: Working", "π mine: Working")).toBeFalse();
		expect(shouldOverwriteCmuxStatus("π other: Waiting", "π mine: Working", "π mine: Error")).toBeTrue();
	});

	test("only clears when the current value still matches the last written value", () => {
		expect(shouldOverwriteCmuxStatus("π mine: Ready", "π mine: Ready", null)).toBeTrue();
		expect(shouldOverwriteCmuxStatus("π other: Waiting", "π mine: Ready", null)).toBeFalse();
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

	test("returns an empty map for invalid json", () => {
		expect(Array.from(parseCmuxStatusList("not json").entries())).toEqual([]);
	});
});
