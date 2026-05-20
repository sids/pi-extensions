import { describe, expect, test } from "vitest";
import { buildGlimpseHtml, buildOpenBrowserCommand, isGlimpseInstalled, openInDefaultBrowser, openInGlimpse } from "../opener";

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

describe("Glimpse opener", () => {
	test("detects whether glimpseui is installed", async () => {
		const calls: any[] = [];
		const pi = {
			exec: async (command: string, args: string[], options: any) => {
				calls.push({ command, args, options });
				return { stdout: "", stderr: "", code: 0 };
			},
		} as any;

		await expect(isGlimpseInstalled(pi, "/tmp/project")).resolves.toBe(true);
		expect(calls[0]).toMatchObject({
			command: "glimpseui",
			args: ["--help"],
			options: { cwd: "/tmp/project", timeout: 1500 },
		});
	});

	test("returns false when glimpseui detection fails", async () => {
		const pi = {
			exec: async () => ({ stdout: "", stderr: "not found", code: 127 }),
		} as any;

		await expect(isGlimpseInstalled(pi, "/tmp/project")).resolves.toBe(false);
	});

	test("builds an iframe shell for the review URL", () => {
		const html = buildGlimpseHtml("http://127.0.0.1:1234/review/token");
		expect(html).toContain('<iframe src="http://127.0.0.1:1234/review/token" title="pi diff review"></iframe>');
	});

	test("launches glimpseui through a detached node process", async () => {
		const calls: any[] = [];
		const pi = {
			exec: async (command: string, args: string[], options: any) => {
				calls.push({ command, args, options });
				return { stdout: "", stderr: "", code: 0 };
			},
		} as any;

		await expect(openInGlimpse(pi, "/tmp/project", "http://127.0.0.1:1234/review/token")).resolves.toMatchObject({ code: 0 });
		expect(calls[0].command).toBe(process.execPath);
		expect(calls[0].args[0]).toBe("-e");
		expect(calls[0].args[1]).toContain("glimpseui");
		expect(calls[0].args[2]).toMatch(/review\.html$/);
		expect(calls[0].options).toMatchObject({ cwd: "/tmp/project", timeout: 1500 });
	});
});
