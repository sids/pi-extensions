import { describe, expect, test } from "bun:test";
import { initTheme } from "@mariozechner/pi-coding-agent";
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

function renderComponent(component: { render: (width: number) => string[] } | undefined): string {
	if (!component) {
		throw new Error("expected component to be defined");
	}
	return component.render(200).join("\n");
}

describe("tool-display extension", () => {
	test("registers overrides for the requested built-in tools", () => {
		const tools: Array<{ name: string }> = [];

		toolDisplayExtension(
			{
				registerTool(tool: { name: string }) {
					tools.push(tool);
				},
			} as any,
		);

		expect(tools.map((tool) => tool.name)).toEqual(["read", "write", "bash", "edit", "grep", "find", "ls"]);
	});

	test("delegates execution using the active ctx.cwd", async () => {
		const tools: Array<{ name: string; execute: (...args: any[]) => Promise<any> }> = [];

		toolDisplayExtension(
			{
				registerTool(tool: { name: string; execute: (...args: any[]) => Promise<any> }) {
					tools.push(tool);
				},
			} as any,
		);

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
		const tools: Array<{
			name: string;
			execute: (...args: any[]) => Promise<any>;
			renderCall?: (...args: any[]) => { render: (width: number) => string[] };
			renderResult?: (...args: any[]) => { render: (width: number) => string[] };
		}> = [];

		toolDisplayExtension(
			{
				registerTool(tool: any) {
					tools.push(tool);
				},
			} as any,
		);

		const readTool = tools.find((tool) => tool.name === "read");
		const writeTool = tools.find((tool) => tool.name === "write");
		if (!readTool?.renderCall || !readTool.renderResult || !writeTool?.renderResult) {
			throw new Error("expected read/write tool renderers to be registered");
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
				writeTool.renderResult(writeResult, { expanded: false, isPartial: false }, theme),
			);

			expect(writeCollapsed).toContain("line 1");
			expect(writeCollapsed).toContain("line 10");
			expect(writeCollapsed).not.toContain("line 11");
			expect(writeCollapsed).toContain("ctrl+o");
			expect(writeResult.details.toolDisplay.content).toBe(content);
		} finally {
			await rm(tempRoot, { recursive: true, force: true });
		}
	});
});
