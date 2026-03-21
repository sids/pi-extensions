import type { Theme } from "@mariozechner/pi-coding-agent";
import {
	Key,
	matchesKey,
	SelectList,
	truncateToWidth,
	type Component,
	type SelectItem,
	type SelectListTheme,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import { cycleVerbosity, formatVerbosityLabel, type OpenAIParamsState } from "./utils";

type MenuItemValue = "fast" | "verbosity";

type MenuItem = SelectItem & {
	value: MenuItemValue;
};

type OpenAIParamsScreenOptions = {
	modelLabel?: string;
	onSave: (nextState: OpenAIParamsState) => void;
	onCancel: () => void;
};

function createSelectListTheme(theme: Theme): SelectListTheme {
	return {
		selectedPrefix: (text: string) => theme.fg("accent", text),
		selectedText: (text: string) => theme.fg("accent", text),
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("dim", text),
		noMatch: (text: string) => theme.fg("warning", text),
	};
}

function buildMenuItems(state: OpenAIParamsState): MenuItem[] {
	return [
		{
			value: "fast",
			label: `Fast mode: ${state.fast ? "on" : "off"}`,
			description: "Toggle service_tier=priority on supported models",
		},
		{
			value: "verbosity",
			label: `Verbosity: ${formatVerbosityLabel(state.verbosity)}`,
			description: "Cycle text.verbosity (default leaves it unset)",
		},
	];
}

export class OpenAIParamsScreen implements Component {
	private tui: TUI;
	private theme: Theme;
	private options: OpenAIParamsScreenOptions;
	private draft: OpenAIParamsState;
	private selectList: SelectList;
	private selectedValue: MenuItemValue;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	constructor(tui: TUI, theme: Theme, initialState: OpenAIParamsState, options: OpenAIParamsScreenOptions) {
		this.tui = tui;
		this.theme = theme;
		this.options = options;
		this.draft = { ...initialState };
		this.selectedValue = "fast";
		this.selectList = this.createSelectList();
	}

	private createSelectList(): SelectList {
		const items = buildMenuItems(this.draft);
		const list = new SelectList(items, items.length, createSelectListTheme(this.theme));
		list.onSelectionChange = (item) => {
			this.selectedValue = item.value as MenuItemValue;
		};
		const index = Math.max(
			0,
			items.findIndex((item) => item.value === this.selectedValue),
		);
		list.setSelectedIndex(index);
		this.selectedValue = items[index]?.value ?? "fast";
		return list;
	}

	private refreshList(): void {
		this.selectList = this.createSelectList();
		this.invalidate();
		this.tui.requestRender();
	}

	private toggleFast(): void {
		this.draft.fast = !this.draft.fast;
		this.refreshList();
	}

	private cycleVerbosity(direction: "forward" | "backward"): void {
		this.draft.verbosity = cycleVerbosity(this.draft.verbosity, direction);
		this.refreshList();
	}

	private activateSelection(): void {
		switch (this.selectedValue) {
			case "fast":
				this.toggleFast();
				return;
			case "verbosity":
				this.cycleVerbosity("forward");
				return;
		}
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		this.selectList.invalidate();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.options.onCancel();
			return;
		}

		if (matchesKey(data, Key.ctrl("s"))) {
			this.options.onSave({ ...this.draft });
			return;
		}

		if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
			this.activateSelection();
			return;
		}

		if (this.selectedValue === "fast") {
			if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
				this.toggleFast();
				return;
			}
		}

		if (this.selectedValue === "verbosity") {
			if (matchesKey(data, Key.left)) {
				this.cycleVerbosity("backward");
				return;
			}
			if (matchesKey(data, Key.right)) {
				this.cycleVerbosity("forward");
				return;
			}
		}

		this.selectList.handleInput(data);
		this.selectedValue = (this.selectList.getSelectedItem()?.value as MenuItemValue | undefined) ?? this.selectedValue;
		this.invalidate();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const boxWidth = Math.max(4, Math.min(width, 120));
		if (boxWidth <= 4) {
			return [truncateToWidth("OpenAI params", width)];
		}

		const contentWidth = Math.max(1, boxWidth - 4);
		const lines: string[] = [];
		const horizontalLine = (count: number) => "─".repeat(Math.max(0, count));
		const padToWidth = (line: string): string => {
			const visibleLength = visibleWidth(line);
			return line + " ".repeat(Math.max(0, width - visibleLength));
		};
		const boxLine = (content: string = "", leftPad: number = 2): string => {
			const paddedContent = `${" ".repeat(leftPad)}${truncateToWidth(content, Math.max(0, contentWidth - leftPad))}`;
			const visibleLength = visibleWidth(paddedContent);
			const rightPad = Math.max(0, boxWidth - visibleLength - 2);
			return `${this.theme.fg("dim", "│")}${paddedContent}${" ".repeat(rightPad)}${this.theme.fg("dim", "│")}`;
		};
		const emptyBoxLine = (): string => `${this.theme.fg("dim", "│")}${" ".repeat(Math.max(0, boxWidth - 2))}${this.theme.fg("dim", "│")}`;
		const separator = this.theme.fg("accent", " · ");
		const formatHint = (shortcut: string, action: string) => `${this.theme.bold(shortcut)} ${this.theme.italic(action)}`;
		const controls = [
			formatHint("↑↓", "navigate"),
			formatHint("Enter/Space", "change"),
			formatHint("←→", "cycle value"),
			formatHint("Ctrl+S", "save"),
			formatHint("Esc", "cancel"),
		].join(separator);
		const notes = [
			this.options.modelLabel ? `Current model: ${this.options.modelLabel}` : undefined,
			"Fast mode sends service_tier=priority on supported GPT-5.4 model routes.",
			"Verbosity sets text.verbosity for OpenAI Responses-family models.",
		]
			.filter((line): line is string => Boolean(line));

		lines.push(padToWidth(this.theme.fg("dim", `╭${horizontalLine(boxWidth - 2)}╮`)));
		lines.push(padToWidth(boxLine(this.theme.fg("accent", this.theme.bold("OpenAI params")))));
		lines.push(padToWidth(this.theme.fg("dim", `├${horizontalLine(boxWidth - 2)}┤`)));

		for (const note of notes) {
			for (const line of wrapTextWithAnsi(this.theme.fg("muted", note), contentWidth)) {
				lines.push(padToWidth(boxLine(line)));
			}
		}

		lines.push(padToWidth(emptyBoxLine()));
		for (const line of this.selectList.render(contentWidth)) {
			lines.push(padToWidth(boxLine(line)));
		}
		lines.push(padToWidth(emptyBoxLine()));
		lines.push(padToWidth(this.theme.fg("dim", `├${horizontalLine(boxWidth - 2)}┤`)));
		for (const line of wrapTextWithAnsi(controls, contentWidth)) {
			lines.push(padToWidth(boxLine(line)));
		}
		lines.push(padToWidth(this.theme.fg("dim", `╰${horizontalLine(boxWidth - 2)}╯`)));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}
