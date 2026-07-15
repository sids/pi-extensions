import { describe, expect, test, vi } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { SideChatComponent, SIDE_OVERLAY_OPTIONS, sidePanelHeight } from "../side-tui";

initTheme(undefined, false);

function createHarness() {
	const tui = { requestRender: vi.fn(), terminal: { rows: 40, columns: 120 } } as any;
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		getThinkingBorderColor: vi.fn(() => (text: string) => text),
	} as any;
	const bindings: Record<string, string> = {
		"tui.input.submit": "ctrl+enter",
		"tui.input.newLine": "alt+enter",
		"app.model.select": "ctrl+m",
		"app.model.cycleForward": "ctrl+right",
		"app.model.cycleBackward": "ctrl+left",
		"app.thinking.cycle": "ctrl+t",
		"app.interrupt": "escape",
	};
	const keybindings = {
		matches: (data: string, id: string) => data === bindings[id],
		getKeys: (id: string) => (bindings[id] ? [bindings[id]] : []),
	} as any;
	const listeners = new Set<() => void>();
	const controller = {
		state: {
			transcript: [{ kind: "user", text: "A long question that should wrap safely inside the floating window." }],
			streamingMessage: undefined,
			isRunning: false,
			summaryStatus: "ready",
			model: { provider: "test", id: "model" },
			thinkingLevel: "low",
		},
		getToolDefinition: () => undefined,
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		submit: vi.fn(async () => true),
		abort: vi.fn(async () => undefined),
		cycleModel: vi.fn(async () => undefined),
		cycleThinkingLevel: vi.fn(),
	} as any;
	const parentView = {
		status: () => ({ parentState: "running", unreadCount: 3, branchChanged: true }),
	} as any;
	const close = vi.fn();
	const selectModel = vi.fn(async () => undefined);
	const toggle = vi.fn();
	const component = new SideChatComponent(tui, theme, keybindings, controller, parentView, "/tmp/project", close, selectModel, toggle);
	return {
		component,
		controller,
		close,
		selectModel,
		toggle,
		theme,
		tui,
		notify: () => listeners.forEach((listener) => listener()),
	};
}

describe("SideChatComponent", () => {
	test("renders width-safe live side and parent state at half the terminal height", () => {
		const harness = createHarness();
		const lines = harness.component.render(52);
		expect(lines.join("\n")).toContain("Side · test/model · low · idle");
		expect(lines.join("\n")).toContain("Main running · 3 unread · branch changed");
		expect(lines.every((line) => visibleWidth(line) <= 52)).toBe(true);
		expect(lines.join("\n")).not.toContain("\u001b]133;");
		expect(lines).toHaveLength(sidePanelHeight(40));
		expect(SIDE_OVERLAY_OPTIONS.maxHeight).toBe("50%");

		harness.controller.state.transcript.push(
			{ kind: "summary", text: "Visible parent summary", available: true, timestamp: 1 },
			{ kind: "notice", text: "Parent summary ready" },
			{
				kind: "tool",
				id: "call-1",
				name: "read",
				args: { path: "README.md" },
				status: "done",
				result: { content: [{ type: "text", text: "file contents" }], isError: false },
				partial: false,
			},
		);
		harness.component.invalidate();
		const updated = harness.component.render(52);
		expect(updated).toHaveLength(sidePanelHeight(40));
		harness.tui.terminal.rows = 60;
		const resized = harness.component.render(52);
		expect(resized).toHaveLength(sidePanelHeight(60));
		expect(resized.join("\n")).toContain("Parent summary ready");
		expect(updated.join("\n")).toContain("Visible parent summary");
		expect(updated.join("\n")).toContain("read");
		harness.component.dispose();
	});

	test("colors the editor borders for the side thinking level", () => {
		const harness = createHarness();
		expect(harness.theme.getThinkingBorderColor).toHaveBeenCalledWith("low");
		harness.controller.state.thinkingLevel = "high";
		harness.notify();
		expect(harness.theme.getThinkingBorderColor).toHaveBeenCalledWith("high");
		harness.component.dispose();
	});

	test("honors injected model, thinking, interrupt, and close bindings", async () => {
		const harness = createHarness();
		harness.component.handleInput("ctrl+right");
		harness.component.handleInput("ctrl+left");
		harness.component.handleInput("ctrl+t");
		harness.component.handleInput("ctrl+m");
		expect(harness.controller.cycleModel).toHaveBeenNthCalledWith(1, "forward");
		expect(harness.controller.cycleModel).toHaveBeenNthCalledWith(2, "backward");
		expect(harness.controller.cycleThinkingLevel).toHaveBeenCalledOnce();
		expect(harness.selectModel).toHaveBeenCalledOnce();

		harness.controller.state.isRunning = true;
		harness.component.handleInput("escape");
		expect(harness.controller.abort).toHaveBeenCalledOnce();
		harness.component.handleInput("\u0003");
		expect(harness.close).toHaveBeenCalledOnce();
		harness.component.dispose();
	});

	test("submits editor text only while idle and supports configured newline", async () => {
		const harness = createHarness();
		harness.component.handleInput("h");
		harness.component.handleInput("i");
		harness.component.handleInput("alt+enter");
		harness.component.handleInput("x");
		harness.component.handleInput("ctrl+enter");
		await Promise.resolve();
		expect(harness.controller.submit).toHaveBeenCalledWith("hi\nx");
		harness.component.dispose();
	});

	test("allows typing but not sending while summary is pending", async () => {
		const harness = createHarness();
		harness.controller.state.summaryStatus = "pending";
		harness.component.handleInput("d");
		harness.component.handleInput("r");
		harness.component.handleInput("a");
		harness.component.handleInput("f");
		harness.component.handleInput("t");
		harness.component.handleInput("ctrl+enter");
		await Promise.resolve();
		expect(harness.controller.submit).not.toHaveBeenCalled();
		const rendered = harness.component.render(60).join("\n");
		expect(rendered).toContain("summarising");
		expect(rendered).toContain("Summarising parent conversation");
		expect(rendered).not.toContain("Enter");
		harness.component.dispose();
	});

	test("renders summary readiness in the scrolling transcript above the editor", () => {
		const harness = createHarness();
		harness.controller.state.transcript = [
			{ kind: "summary", text: "Visible parent summary", available: true, timestamp: 1 },
			{ kind: "notice", text: "Parent summary ready" },
		];
		harness.component.invalidate();
		const lines = harness.component.render(80);
		const noticeIndex = lines.findIndex((line) => line.includes("Parent summary ready"));
		expect(noticeIndex).toBeGreaterThan(0);
		expect(lines[noticeIndex + 1]).toContain("─");
		expect(lines.at(-3)).not.toContain("Parent summary ready");
		harness.component.dispose();
	});

	test("places transient status and footer directly below the editor", () => {
		const harness = createHarness();
		harness.controller.state.statusMessage = "Side turn interrupted";
		harness.component.invalidate();
		const lines = harness.component.render(80);
		const statusIndex = lines.findIndex((line) => line.includes("Side turn interrupted"));
		expect(statusIndex).toBeGreaterThan(0);
		expect(lines[statusIndex - 1]).toContain("─");
		expect(lines[statusIndex + 1]).toContain("PgUp/PgDn scroll");
		harness.component.dispose();
	});

	test("uses a centered overlay, triage-style hints, and reserves ctrl+shift+s for toggling", () => {
		const harness = createHarness();
		expect(SIDE_OVERLAY_OPTIONS.anchor).toBe("center");
		const footer = harness.component.render(80).at(-2) ?? "";
		expect(footer).not.toContain("Enter");
		expect(footer).toContain("PgUp/PgDn scroll");
		expect(footer).toContain("Ctrl+Shift+S hide");
		expect(footer).toContain("Ctrl+C close");
		expect(footer).not.toContain("model");
		expect(footer).not.toContain("thinking");
		harness.component.handleInput("\u001b[115;6u");
		expect(harness.toggle).toHaveBeenCalledOnce();
		expect(harness.controller.submit).not.toHaveBeenCalled();
		harness.component.dispose();
	});
});
