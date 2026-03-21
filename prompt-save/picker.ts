import type { Theme } from "@mariozechner/pi-coding-agent";
import {
	matchesKey,
	SelectList,
	truncateToWidth,
	type Component,
	type SelectListTheme,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import { buildPromptPreview, type SavedPromptItem } from "./utils";

type PromptSavePickerOptions = {
	onClose: () => void;
	onUseItem: (item: SavedPromptItem) => void;
	onCopyItem: (item: SavedPromptItem) => void;
	onDeleteItem: (itemId: string) => SavedPromptItem[];
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

function toDisplayItems(items: SavedPromptItem[]): SavedPromptItem[] {
	return [...items].reverse();
}

export class PromptSavePicker implements Component {
	private tui: TUI;
	private theme: Theme;
	private options: PromptSavePickerOptions;
	private items: SavedPromptItem[] = [];
	private selectList: SelectList | null = null;
	private selectedId: string | undefined;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	constructor(tui: TUI, theme: Theme, items: SavedPromptItem[], options: PromptSavePickerOptions) {
		this.tui = tui;
		this.theme = theme;
		this.options = options;
		this.setItems(items);
	}

	setItems(items: SavedPromptItem[], preferredSelectedId?: string): void {
		this.items = toDisplayItems(items);
		this.rebuildSelectList(preferredSelectedId);
		this.invalidate();
	}

	private rebuildSelectList(preferredSelectedId?: string): void {
		if (this.items.length === 0) {
			this.selectList = null;
			this.selectedId = undefined;
			return;
		}

		this.selectList = new SelectList(
			this.items.map((item) => ({
				value: item.id,
				...buildPromptPreview(item.text),
			})),
			Math.min(Math.max(this.items.length, 1), 8),
			createSelectListTheme(this.theme),
		);
		this.selectList.onSelectionChange = (item) => {
			this.selectedId = item.value;
		};

		const nextSelectedId = preferredSelectedId && this.items.some((item) => item.id === preferredSelectedId)
			? preferredSelectedId
			: this.selectedId && this.items.some((item) => item.id === this.selectedId)
				? this.selectedId
				: this.items[0]?.id;
		const nextSelectedIndex = Math.max(
			0,
			this.items.findIndex((item) => item.id === nextSelectedId),
		);
		this.selectList.setSelectedIndex(nextSelectedIndex);
		this.selectedId = this.items[nextSelectedIndex]?.id;
	}

	private getSelectedItem(): SavedPromptItem | null {
		if (!this.selectList) {
			return null;
		}

		const selected = this.selectList.getSelectedItem();
		if (!selected) {
			return null;
		}

		return this.items.find((item) => item.id === selected.value) ?? null;
	}

	private getPreferredSelectionAfterDelete(): string | undefined {
		const selectedItem = this.getSelectedItem();
		if (!selectedItem) {
			return undefined;
		}

		const selectedIndex = this.items.findIndex((item) => item.id === selectedItem.id);
		if (selectedIndex < 0) {
			return undefined;
		}

		return this.items[selectedIndex + 1]?.id ?? this.items[selectedIndex - 1]?.id;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		this.selectList?.invalidate();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.options.onClose();
			return;
		}

		const selectedItem = this.getSelectedItem();
		if (selectedItem && matchesKey(data, "enter")) {
			this.options.onUseItem(selectedItem);
			return;
		}

		if (selectedItem && matchesKey(data, "ctrl+alt+c")) {
			this.options.onCopyItem(selectedItem);
			return;
		}

		if (selectedItem && matchesKey(data, "ctrl+d")) {
			const preferredSelectedId = this.getPreferredSelectionAfterDelete();
			const nextItems = this.options.onDeleteItem(selectedItem.id);
			this.setItems(nextItems, preferredSelectedId);
			this.tui.requestRender();
			return;
		}

		if (!this.selectList) {
			return;
		}

		this.selectList.handleInput(data);
		this.selectedId = this.selectList.getSelectedItem()?.value;
		this.invalidate();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const boxWidth = Math.max(4, Math.min(width, 120));
		if (boxWidth <= 4) {
			return [truncateToWidth("Saved prompts", width)];
		}
		const contentWidth = Math.max(1, boxWidth - 4);
		const lines: string[] = [];
		const separator = this.theme.fg("accent", " · ");
		const formatHint = (shortcut: string, action: string) => `${this.theme.bold(shortcut)} ${this.theme.italic(action)}`;
		const controls = [
			formatHint("Enter", "insert"),
			formatHint("Ctrl+Alt+C", "copy"),
			formatHint("Ctrl+D", "remove"),
			formatHint("Esc", "close"),
		].join(separator);
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

		lines.push(padToWidth(this.theme.fg("dim", `╭${horizontalLine(boxWidth - 2)}╮`)));
		lines.push(
			padToWidth(
				boxLine(
					`${this.theme.fg("accent", this.theme.bold("Saved prompts"))}${this.theme.fg("dim", ` (${this.items.length})`)}`,
				),
			),
		);
		lines.push(padToWidth(this.theme.fg("dim", `├${horizontalLine(boxWidth - 2)}┤`)));
		lines.push(padToWidth(emptyBoxLine()));

		if (this.selectList) {
			for (const line of this.selectList.render(contentWidth)) {
				lines.push(padToWidth(boxLine(line)));
			}
		} else {
			for (const line of wrapTextWithAnsi(this.theme.fg("dim", "No saved prompts in this session yet."), contentWidth)) {
				lines.push(padToWidth(boxLine(line)));
			}
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
