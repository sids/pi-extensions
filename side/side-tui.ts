import {
	AssistantMessageComponent,
	CustomMessageComponent,
	getMarkdownTheme,
	ToolExecutionComponent,
	type KeybindingsManager,
	type Theme,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
	Editor,
	Key,
	Loader,
	matchesKey,
	truncateToWidth,
	type Focusable,
	type TUI,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { ParentSessionView } from "./parent-session";
import type { SideSessionController, SideTranscriptItem } from "./side-session";

export function sidePanelHeight(terminalRows: number): number {
	return Math.max(1, Math.floor(terminalRows * 0.5));
}

const PROMPT_ZONE_PATTERN = /\x1b\]133;[ABC]\x07/g;

function stripPromptZones(text: string): string {
	return text.replace(PROMPT_ZONE_PATTERN, "");
}

function pad(text: string, width: number): string {
	const truncated = truncateToWidth(text, Math.max(1, width), "…");
	return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

export class SideChatComponent implements Focusable {
	private _focused = false;
	private readonly editor: Editor;
	private readonly summaryLoader: Loader;
	private unsubscribe?: () => void;
	private statusTimer?: ReturnType<typeof setInterval>;
	private scrollOffset = 0;
	private selectingModel = false;
	private cachedWidth?: number;
	private cachedHeight?: number;
	private cachedLines?: string[];
	private toolComponents = new Map<
		string,
		{
			component: ToolExecutionComponent;
			args: unknown;
			result?: Extract<SideTranscriptItem, { kind: "tool" }>["result"];
			partial: boolean;
		}
	>();

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly controller: SideSessionController,
		private readonly parentView: ParentSessionView,
		private readonly cwd: string,
		private readonly onClose: () => void,
		private readonly onSelectModel: () => Promise<void>,
		private readonly onToggle: () => void,
		initialText: string = "",
	) {
		this.editor = new Editor(tui, {
			borderColor: theme.getThinkingBorderColor(controller.state.thinkingLevel),
			selectList: {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			},
		});
		this.summaryLoader = new Loader(
			tui,
			(text) => theme.fg("accent", text),
			(text) => theme.fg("muted", text),
			"Summarising parent conversation…",
		);
		if (controller.state.summaryStatus === "pending") {
			this.summaryLoader.start();
		}
		this.editor.disableSubmit = true;
		this.editor.setText(initialText);
		this.editor.onChange = () => {
			this.invalidate();
			this.tui.requestRender();
		};
		this.unsubscribe = controller.subscribe(() => {
			this.editor.borderColor = theme.getThinkingBorderColor(controller.state.thinkingLevel);
			if (controller.state.summaryStatus !== "pending") {
				this.summaryLoader.stop();
			}
			this.scrollOffset = 0;
			this.invalidate();
			this.tui.requestRender();
		});
		this.statusTimer = setInterval(() => {
			this.invalidate();
			this.tui.requestRender();
		}, 750);
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.editor.focused = value;
	}

	private renderTranscriptItem(item: SideTranscriptItem, width: number): string[] {
		const markdownTheme = getMarkdownTheme();
		switch (item.kind) {
			case "summary":
				return new CustomMessageComponent(
					{
						role: "custom",
						customType: item.available ? "Summary" : "Summary unavailable",
						content: item.text,
						display: true,
						timestamp: item.timestamp,
					},
					undefined,
					markdownTheme,
				).render(width);
			case "notice":
				return [this.theme.fg("warning", item.text)];
			case "user":
				return new UserMessageComponent(item.text, markdownTheme, 1).render(width);
			case "assistant":
				return new AssistantMessageComponent(item.message, false, markdownTheme, undefined, 0).render(width);
			case "tool": {
				let renderedTool = this.toolComponents.get(item.id);
				if (!renderedTool) {
					const component = new ToolExecutionComponent(
						item.name,
						item.id,
						item.args,
						{ showImages: false },
						this.controller.getToolDefinition(item.name),
						this.tui,
						this.cwd,
					);
					component.markExecutionStarted();
					component.setArgsComplete();
					renderedTool = { component, args: item.args, partial: item.partial };
					this.toolComponents.set(item.id, renderedTool);
				}
				if (renderedTool.args !== item.args) {
					renderedTool.component.updateArgs(item.args);
					renderedTool.args = item.args;
				}
				if (item.result && (renderedTool.result !== item.result || renderedTool.partial !== item.partial)) {
					renderedTool.component.updateResult(item.result, item.partial);
					renderedTool.result = item.result;
					renderedTool.partial = item.partial;
				}
				return renderedTool.component.render(width);
			}
			case "error":
				return [this.theme.fg("error", `Error: ${item.text}`)];
		}
	}

	private transcriptLines(width: number): string[] {
		const lines: string[] = [];
		if (this.controller.state.summaryStatus === "pending") {
			lines.push(...this.summaryLoader.render(width), "");
		}
		for (const item of this.controller.state.transcript) {
			lines.push(...this.renderTranscriptItem(item, width).map(stripPromptZones), "");
		}
		if (this.controller.state.streamingMessage) {
			lines.push(
				...new AssistantMessageComponent(
					this.controller.state.streamingMessage,
					false,
					getMarkdownTheme(),
					undefined,
					0,
				).render(width).map(stripPromptZones),
			);
		}
		if (lines.at(-1) === "") {
			lines.pop();
		}
		if (lines.length === 0) {
			lines.push(this.theme.fg("dim", "Ask a question without interrupting the main chat."));
		}
		return lines;
	}

	private visibleTranscript(width: number, height: number): string[] {
		const all = this.transcriptLines(width);
		const maxOffset = Math.max(0, all.length - height);
		this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
		const end = all.length - this.scrollOffset;
		const start = Math.max(0, end - height);
		const visible = all.slice(start, end);
		while (visible.length < height) {
			visible.unshift("");
		}
		return visible;
	}

	private editorLines(width: number, maxHeight: number): string[] {
		const rendered = this.editor.render(width);
		if (maxHeight <= 1) {
			return rendered.slice(-1);
		}
		if (rendered.length <= maxHeight) {
			return rendered;
		}
		return [rendered[0], ...rendered.slice(-(maxHeight - 1))];
	}

	private async submit(): Promise<void> {
		const text = this.editor.getExpandedText();
		if (!(await this.controller.submit(text))) {
			return;
		}
		this.editor.addToHistory(text);
		this.editor.setText("");
		this.invalidate();
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.ctrlShift("s"))) {
			this.onToggle();
			return;
		}
		if (matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.ctrl("d"))) {
			this.onClose();
			return;
		}
		if (this.keybindings.matches(data, "app.model.select")) {
			if (!this.selectingModel) {
				this.selectingModel = true;
				void this.onSelectModel().finally(() => {
					this.selectingModel = false;
					this.invalidate();
					this.tui.requestRender();
				});
			}
			return;
		}
		if (this.keybindings.matches(data, "app.model.cycleForward")) {
			void this.controller.cycleModel("forward");
			return;
		}
		if (this.keybindings.matches(data, "app.model.cycleBackward")) {
			void this.controller.cycleModel("backward");
			return;
		}
		if (this.keybindings.matches(data, "app.thinking.cycle")) {
			this.controller.cycleThinkingLevel();
			return;
		}
		if (this.keybindings.matches(data, "app.interrupt")) {
			if (this.controller.state.isRunning) {
				void this.controller.abort();
			}
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			this.scrollOffset += Math.max(1, Math.floor(sidePanelHeight(this.tui.terminal.rows) / 4));
			this.invalidate();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.scrollOffset = Math.max(
				0,
				this.scrollOffset - Math.max(1, Math.floor(sidePanelHeight(this.tui.terminal.rows) / 4)),
			);
			this.invalidate();
			this.tui.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.input.submit")) {
			if (!this.controller.state.isRunning && this.controller.state.summaryStatus !== "pending") {
				void this.submit();
			}
			return;
		}
		if (this.keybindings.matches(data, "tui.input.newLine")) {
			this.editor.insertTextAtCursor("\n");
			return;
		}
		this.editor.handleInput(data);
		this.invalidate();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const panelHeight = sidePanelHeight(this.tui.terminal.rows);
		if (this.cachedLines && this.cachedWidth === width && this.cachedHeight === panelHeight) {
			return this.cachedLines;
		}
		const safeWidth = Math.max(20, width);
		const innerWidth = Math.max(1, safeWidth - 2);
		const border = (text: string) => this.theme.fg("borderAccent", text);
		const row = (text: string) => border("│") + pad(` ${text}`, innerWidth) + border("│");
		const state = this.controller.state;
		const parent = this.parentView.status();
		const model = state.model ? `${state.model.provider}/${state.model.id}` : "no model";
		const childState = state.summaryStatus === "pending"
			? "summarising"
			: state.isRunning
				? "running"
				: "idle";
		const unread = parent.unreadCount > 0 ? ` · ${parent.unreadCount} unread` : "";
		const branch = parent.branchChanged ? " · branch changed" : "";
		const lines: string[] = [
			border(`╭${"─".repeat(innerWidth)}╮`),
			row(`${this.theme.bold("Side")} · ${model} · ${state.thinkingLevel} · ${childState}`),
			row(this.theme.fg("dim", `Main ${parent.parentState}${unread}${branch}`)),
			border(`├${"─".repeat(innerWidth)}┤`),
		];
		const editorLines = this.editorLines(
			Math.max(10, innerWidth - 2),
			Math.max(1, Math.floor(panelHeight / 4)),
		);
		const statusHeight = state.statusMessage ? 1 : 0;
		const transcriptHeight = Math.max(0, panelHeight - 6 - editorLines.length - statusHeight);
		for (const line of this.visibleTranscript(innerWidth - 2, transcriptHeight)) {
			lines.push(row(line));
		}
		for (const editorLine of editorLines) {
			lines.push(row(editorLine));
		}
		if (state.statusMessage) {
			lines.push(row(this.theme.fg("warning", state.statusMessage)));
		}

		const separator = this.theme.fg("muted", " · ");
		const hint = (shortcut: string, action: string) => `${this.theme.bold(shortcut)} ${this.theme.fg("muted", action)}`;
		const controls = [
			hint("PgUp/PgDn", "scroll"),
			hint("Ctrl+Shift+S", "hide"),
			hint("Ctrl+C", "close"),
		].join(separator);
		lines.push(row(controls));
		lines.push(border(`╰${"─".repeat(innerWidth)}╯`));

		this.cachedWidth = width;
		this.cachedHeight = panelHeight;
		this.cachedLines = lines.map((line) => truncateToWidth(line, safeWidth, "")).slice(0, panelHeight);
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedHeight = undefined;
		this.cachedLines = undefined;
		this.editor.invalidate();
	}

	dispose(): void {
		this.summaryLoader.stop();
		if (this.statusTimer) {
			clearInterval(this.statusTimer);
			this.statusTimer = undefined;
		}
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.toolComponents.clear();
	}
}

export const SIDE_OVERLAY_OPTIONS = {
	anchor: "center" as const,
	width: "58%" as const,
	minWidth: 50,
	maxHeight: "50%" as const,
	margin: 1,
};
