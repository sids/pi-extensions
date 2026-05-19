import { describe, expect, test } from "vitest";
import { buildOpenBrowserCommand, openInDefaultBrowser } from "../opener";

describe("buildOpenBrowserCommand", () => {
	test("uses open on macOS", () => {
		expect(buildOpenBrowserCommand("http://127.0.0.1:1234", "darwin")).toEqual({
			command: "open",
			args: ["http://127.0.0.1:1234"],
		});
	});

	test("uses xdg-open on Linux", () => {
		expect(buildOpenBrowserCommand("http://127.0.0.1:1234", "linux")).toEqual({
			command: "xdg-open",
			args: ["http://127.0.0.1:1234"],
		});
	});

	test("uses start on Windows", () => {
		expect(buildOpenBrowserCommand("http://127.0.0.1:1234", "win32")).toEqual({
			command: "cmd",
			args: ["/c", "start", "", "http://127.0.0.1:1234"],
		});
	});
});

describe("openInDefaultBrowser", () => {
	test("executes the platform opener", async () => {
		const calls: any[] = [];
		const pi = {
			exec: async (command: string, args: string[], options: any) => {
				calls.push({ command, args, options });
				return { stdout: "", stderr: "", code: 0 };
			},
		} as any;

		await expect(openInDefaultBrowser(pi, "/tmp/project", "http://127.0.0.1:1234")).resolves.toMatchObject({ code: 0 });
		expect(calls[0].options).toMatchObject({ cwd: "/tmp/project", timeout: 1500 });
	});
});
