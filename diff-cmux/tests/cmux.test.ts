import { describe, expect, test } from "bun:test";
import { buildNewPaneArgs, buildNewSurfaceArgs, parseCmuxIdentify, resolveCmuxCallerContext } from "../cmux";

describe("parseCmuxIdentify", () => {
	test("reads workspace and pane refs from json output", () => {
		expect(
			parseCmuxIdentify(
				JSON.stringify({
					workspace: { id: "workspace:1" },
					caller: { pane_ref: "pane:current" },
				}),
			),
		).toEqual({
			workspaceId: "workspace:1",
			callerPaneRef: "pane:current",
		});
	});

	test("reads workspace and pane refs from field output", () => {
		expect(parseCmuxIdentify("workspace.id=workspace:1 caller.pane_ref=pane:current")).toEqual({
			workspaceId: "workspace:1",
			callerPaneRef: "pane:current",
		});
	});

	test("falls back to the environment workspace id", () => {
		expect(parseCmuxIdentify("caller.pane_ref=pane:current", { CMUX_WORKSPACE_ID: "workspace:env" })).toEqual({
			workspaceId: "workspace:env",
			callerPaneRef: "pane:current",
		});
	});
});

describe("cmux open command builders", () => {
	test("builds the expected pane command", () => {
		expect(buildNewPaneArgs("workspace:1", "http://127.0.0.1:1234/viewer/token")).toEqual([
			"new-pane",
			"--type",
			"browser",
			"--direction",
			"right",
			"--workspace",
			"workspace:1",
			"--url",
			"http://127.0.0.1:1234/viewer/token",
		]);
	});

	test("builds the expected surface command", () => {
		expect(buildNewSurfaceArgs("workspace:1", "pane:current", "http://127.0.0.1:1234/viewer/token")).toEqual([
			"new-surface",
			"--type",
			"browser",
			"--workspace",
			"workspace:1",
			"--pane",
			"pane:current",
			"--url",
			"http://127.0.0.1:1234/viewer/token",
		]);
	});
});

describe("resolveCmuxCallerContext", () => {
	test("parses cmux identify output", async () => {
		const pi = {
			exec: async (_command: string, _args: string[]) => ({
				stdout: '{"workspace":{"id":"workspace:1"},"caller":{"pane_ref":"pane:current"}}',
				stderr: "",
				code: 0,
			}),
		} as any;

		await expect(resolveCmuxCallerContext(pi, "/tmp/project", {})).resolves.toEqual({
			workspaceId: "workspace:1",
			callerPaneRef: "pane:current",
		});
	});

	test("returns null when cmux identify fails", async () => {
		const pi = {
			exec: async () => ({ stdout: "", stderr: "not in cmux", code: 1 }),
		} as any;

		await expect(resolveCmuxCallerContext(pi, "/tmp/project")).resolves.toBeNull();
	});
});
