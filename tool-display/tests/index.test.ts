import { describe, expect, test } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import toolDisplayExtension from "../index";

initTheme();

const theme = {
	fg: (_name: string, text: string) => text,
	bg: (_name: string, text: string) => text,
	bold: (text: string) => text,
} as any;

const dimTheme = {
	fg: (name: string, text: string) => (name === "dim" ? `<dim>${text}</dim>` : text),
	bg: (_name: string, text: string) => text,
	bold: (text: string) => text,
} as any;

function renderComponent(component: { render: (width: number) => string[] } | undefined, width = 200): string {
	if (!component) {
		throw new Error("expected component to be defined");
	}
	return component.render(width).join("\n");
}

async function loadTools(activeTools = ["read", "bash", "edit", "write"]) {
	const tools: Array<any> = [];
	const setActiveToolsCalls: string[][] = [];
	const toolPromptGuidelines = new Map(
		["read", "bash", "edit", "write", "grep", "find", "ls"].map((name) => [name, [`Use ${name} for ${name} operations.`]]),
	);
	let sessionStartHandler: ((event: any, ctx: any) => unknown) | undefined;

	toolDisplayExtension(
		{
			on(event: string, handler: (event: any, ctx: any) => unknown) {
				if (event === "session_start") {
					sessionStartHandler = handler;
				}
			},
			registerTool(tool: any) {
				tools.push(tool);
			},
			getActiveTools() {
				return [...activeTools];
			},
			getAllTools() {
				return Array.from(toolPromptGuidelines, ([name, promptGuidelines]) => ({
					name,
					promptGuidelines,
				}));
			},
			setActiveTools(nextTools: string[]) {
				setActiveToolsCalls.push([...nextTools]);
			},
		} as any,
	);

	if (!sessionStartHandler) {
		throw new Error("expected session_start handler to be registered");
	}

	await sessionStartHandler({ reason: "startup" }, { cwd: process.cwd() });

	return { tools, setActiveToolsCalls };
}

describe("tool-display extension", () => {
	test("registers overrides on session start and restores the original active tools", async () => {
		const activeTools = ["read", "bash", "edit", "write"];
		const { tools, setActiveToolsCalls } = await loadTools(activeTools);

		expect(tools.map((tool) => tool.name)).toEqual(["read", "write", "bash", "edit", "grep", "find", "ls"]);
		expect(tools.map((tool) => [tool.name, tool.promptGuidelines])).toEqual([
			["read", ["Use read for read operations."]],
			["write", ["Use write for write operations."]],
			["bash", ["Use bash for bash operations."]],
			["edit", ["Use edit for edit operations."]],
			["grep", ["Use grep for grep operations."]],
			["find", ["Use find for find operations."]],
			["ls", ["Use ls for ls operations."]],
		]);
		expect(setActiveToolsCalls).toEqual([activeTools]);
	});

	test("delegates execution using the active ctx.cwd", async () => {
		const { tools } = await loadTools();

		const readTool = tools.find((tool) => tool.name === "read");
		if (!readTool) {
			throw new Error("read tool was not registered");
		}

		const tempRoot = await mkdtemp(join(tmpdir(), "pi-tool-display-"));
		const firstDir = join(tempRoot, "first");
		const secondDir = join(tempRoot, "second");

		try {
			await mkdir(firstDir, { recursive: true });
			await mkdir(secondDir, { recursive: true });
			await writeFile(join(firstDir, "sample.txt"), "from first cwd", "utf8");
			await writeFile(join(secondDir, "sample.txt"), "from second cwd", "utf8");

			const firstResult = await readTool.execute(
				"call-1",
				{ path: "sample.txt" },
				undefined,
				undefined,
				{ cwd: firstDir },
			);
			const secondResult = await readTool.execute(
				"call-2",
				{ path: "sample.txt" },
				undefined,
				undefined,
				{ cwd: secondDir },
			);

			expect(firstResult.content[0]?.text).toContain("from first cwd");
			expect(secondResult.content[0]?.text).toContain("from second cwd");
		} finally {
			await rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("renders collapsed previews without the unsupported render context", async () => {
		const { tools } = await loadTools();

		const readTool = tools.find((tool) => tool.name === "read");
		const writeTool = tools.find((tool) => tool.name === "write");
		const bashTool = tools.find((tool) => tool.name === "bash");
		const editTool = tools.find((tool) => tool.name === "edit");
		if (!readTool?.renderCall || !readTool.renderResult || !writeTool?.renderResult || !bashTool?.renderResult || !editTool?.renderCall || !editTool.renderResult) {
			throw new Error("expected read/write/bash/edit tool renderers to be registered");
		}

		const tempRoot = await mkdtemp(join(tmpdir(), "pi-tool-display-render-"));
		try {
			await writeFile(join(tempRoot, "sample.ts"), "const answer = 42;\n", "utf8");

			const readResult = await readTool.execute(
				"call-read",
				{ path: "sample.ts" },
				undefined,
				undefined,
				{ cwd: tempRoot },
			);
			const readCall = renderComponent(readTool.renderCall({ path: "sample.ts" }, theme));
			const readCollapsed = renderComponent(
				readTool.renderResult(readResult, { expanded: false, isPartial: false }, theme),
			);

			expect(readCall).toContain("read");
			expect(readCall).toContain("sample.ts");
			expect(readCollapsed).toContain("loaded 2 lines");
			expect(readCollapsed).toContain("ctrl+o");
			expect(readResult.details.toolDisplay.path).toBe("sample.ts");

			const content = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n");
			const writeResult = await writeTool.execute(
				"call-write",
				{ path: "written.txt", content },
				undefined,
				undefined,
				{ cwd: tempRoot },
			);
			const writeCollapsed = renderComponent(
				writeTool.renderResult(writeResult, { expanded: false, isPartial: false }, dimTheme),
			);

			expect(writeCollapsed).toContain("<dim>line 1");
			expect(writeCollapsed).toContain("line 10");
			expect(writeCollapsed).not.toContain("line 11");
			expect(writeCollapsed).toContain("ctrl+o");
			expect(writeResult.details.toolDisplay.content).toBe(content);

			const bashRunning = renderComponent(
				bashTool.renderResult(
					{ content: [{ type: "text", text: Array.from({ length: 12 }, (_, index) => `out ${index + 1}`).join("\n") }] },
					{ expanded: false, isPartial: true },
					dimTheme,
				),
			);
			expect(bashRunning).toContain("running...");
			expect(bashRunning).not.toContain("out 7");
			expect(bashRunning).toContain("out 8");
			expect(bashRunning).toContain("out 12");
			expect(bashRunning).toContain("7 earlier visual lines");
			expect(bashRunning).toContain("ctrl+o");
			expect(bashRunning).toContain("see the full output");

			const bashFailed = renderComponent(
				bashTool.renderResult(
					{
						isError: true,
						content: [{ type: "text", text: Array.from({ length: 12 }, (_, index) => `err ${index + 1}`).join("\n") }],
					},
					{ expanded: false, isPartial: false },
					theme,
				),
			);
			expect(bashFailed).toContain("command failed");
			expect(bashFailed).not.toContain("err 7");
			expect(bashFailed).toContain("err 8");
			expect(bashFailed).toContain("err 12");
			expect(bashFailed).toContain("7 earlier visual lines");
			expect(bashFailed).toContain("ctrl+o");
			expect(bashFailed).toContain("see the full output");

			const bashWrapped = renderComponent(
				bashTool.renderResult(
					{ content: [{ type: "text", text: "abcdefghij\nline2\nline3\nline4\nline5" }] },
					{ expanded: false, isPartial: false },
					theme,
				),
				5,
			);
			expect(bashWrapped).not.toContain("abcde");
			expect(bashWrapped).toContain("fghij");
			expect(bashWrapped).toContain("line5");

			const editArgs = {
				path: "edit-target.txt",
				edits: [
					{ oldText: "alpha", newText: "alpha updated" },
					{ oldText: "beta", newText: "beta updated" },
				],
			};
			const editResult = {
				content: [{ type: "text", text: "Successfully replaced 2 block(s) in edit-target.txt." }],
				details: {
					diff: [
						"@@ -1,2 +1,2 @@",
						"-1 alpha",
						"+1 alpha updated",
						"-2 beta",
						"+2 beta updated",
					].join("\n"),
					toolDisplay: { path: "edit-target.txt" },
				},
			};
			const editCall = renderComponent(editTool.renderCall(editArgs, theme));
			const editRendered = renderComponent(
				editTool.renderResult(
					editResult,
					{ expanded: false, isPartial: false },
					theme,
					{ isError: false } as any,
				),
			);
			const editError = "Could not find edits[0] in edit-target.txt. The oldText must match exactly.";
			const failedEditRendered = renderComponent(
				editTool.renderResult(
					{ content: [{ type: "text", text: editError }] },
					{ expanded: false, isPartial: false },
					theme,
					{ isError: true } as any,
				),
			);

			expect(editTool.renderShell).toBe("default");
			expect(editCall).toContain("edit-target.txt");
			expect(editCall).toContain("2 blocks");
			expect(editRendered).toContain("diff");
			expect(editRendered).not.toContain("unified");
			expect(editRendered).toContain("▌");
			expect(editRendered).toContain("│");
			expect(editRendered).toContain("alpha updated");
			expect(editRendered).toContain("beta updated");
			expect(editResult.details.toolDisplay.path).toBe("edit-target.txt");
			expect(failedEditRendered).toContain(editError);
			expect(failedEditRendered).not.toContain("Applied");
		} finally {
			await rm(tempRoot, { recursive: true, force: true });
		}
	});
});
