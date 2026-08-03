import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SelectList, type SelectItem, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { CountdownController, formatCountdownLabel } from "./countdown";

export type ReviewAutoSelectTimingOptions = {
	timeoutMs?: number;
	countdownTickMs?: number;
	now?: () => number;
};

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_COUNTDOWN_TICK_MS = 250;

type TuiComponent = {
	handleInput: (data: string) => void;
	render: (width: number) => string[];
	invalidate: () => void;
	dispose: () => void;
};

class ReviewAutoSelectComponent implements TuiComponent {
	private readonly tui: { requestRender: () => void };
	private readonly title: string;
	private readonly autoSelectItem: SelectItem;
	private readonly selectList: SelectList;
	private readonly onDone: (value: string | undefined) => void;
	private readonly countdown: CountdownController;

	private automaticSelectionActive = true;
	private finished = false;

	private dim = (text: string) => text;
	private bold = (text: string) => text;
	private accent = (text: string) => text;
	private warning = (text: string) => text;
	private muted = (text: string) => text;

	constructor(
		items: SelectItem[],
		title: string,
		autoSelectValue: string,
		tui: { requestRender: () => void },
		onDone: (value: string | undefined) => void,
		options?: {
			dimColor?: (text: string) => string;
			boldText?: (text: string) => string;
			accentColor?: (text: string) => string;
			warningColor?: (text: string) => string;
			mutedColor?: (text: string) => string;
			timing?: ReviewAutoSelectTimingOptions;
		},
	) {
		const autoSelectItem = items.find((item) => item.value === autoSelectValue);
		if (!autoSelectItem) {
			throw new Error(`Automatic review selection not found: ${autoSelectValue}`);
		}

		this.tui = tui;
		this.title = title;
		this.autoSelectItem = autoSelectItem;
		this.onDone = onDone;
		this.dim = options?.dimColor ?? this.dim;
		this.bold = options?.boldText ?? this.bold;
		this.accent = options?.accentColor ?? this.accent;
		this.warning = options?.warningColor ?? this.warning;
		this.muted = options?.mutedColor ?? this.muted;

		this.selectList = new SelectList(items, Math.min(items.length, 10), {
			selectedPrefix: (text) => this.accent(text),
			selectedText: (text) => this.accent(text),
			description: (text) => this.muted(text),
			scrollInfo: (text) => this.dim(text),
			noMatch: (text) => this.warning(text),
		});
		this.selectList.setSelectedIndex(items.indexOf(autoSelectItem));
		this.selectList.onSelect = (item) => this.finish(item.value);
		this.selectList.onCancel = () => this.finish(undefined);

		this.countdown = new CountdownController(
			() => this.finish(this.autoSelectItem.value),
			() => this.tui.requestRender(),
			{
				timeoutMs: options?.timing?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
				countdownTickMs: options?.timing?.countdownTickMs ?? DEFAULT_COUNTDOWN_TICK_MS,
				now: options?.timing?.now,
			},
		);
	}

	private finish(value: string | undefined): void {
		if (this.finished) {
			return;
		}
		this.finished = true;
		this.countdown.stop();
		this.onDone(value);
	}

	private interruptAutomaticSelection(): void {
		if (!this.automaticSelectionActive) {
			return;
		}
		this.automaticSelectionActive = false;
		this.countdown.stop();
	}

	private getCountdownLabel(): string {
		return formatCountdownLabel(this.countdown.getRemainingMs());
	}

	dispose(): void {
		this.countdown.stop();
	}

	invalidate(): void {
		this.selectList.invalidate();
	}

	handleInput(data: string): void {
		this.interruptAutomaticSelection();
		this.selectList.handleInput(data);
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const margin = safeWidth > 1 ? " " : "";
		const lineWidth = Math.max(1, safeWidth - visibleWidth(margin));
		const padLine = (line: string): string => {
			const truncated = truncateToWidth(line, lineWidth);
			return `${margin}${truncated}${" ".repeat(Math.max(0, lineWidth - visibleWidth(truncated)))}`;
		};
		const status = this.automaticSelectionActive
			? `${this.warning("Selecting ")}${this.accent(this.autoSelectItem.label)}${this.warning(` in ${this.getCountdownLabel()}. Press any key to choose manually.`)}`
			: this.muted("Automatic selection paused. Choose an option or press Esc to cancel.");

		return [
			"",
			padLine(this.bold(this.title)),
			padLine(this.dim("─".repeat(Math.max(0, lineWidth - 1)))),
			padLine(status),
			padLine(""),
			...this.selectList.render(Math.max(1, lineWidth)).map((line) => padLine(line)),
			padLine(""),
		];
	}
}

export async function runReviewAutoSelect(
	ctx: ExtensionContext,
	title: string,
	items: SelectItem[],
	autoSelectValue: string,
	timing?: ReviewAutoSelectTimingOptions,
): Promise<string | undefined> {
	if (ctx.mode !== "tui") {
		const labels = items.map((item) => `${item.label}${item.description ? ` ${item.description}` : ""}`);
		const selectedLabel = await ctx.ui.select(title, labels);
		const selectedIndex = labels.indexOf(selectedLabel ?? "");
		return selectedIndex >= 0 ? items[selectedIndex]?.value : undefined;
	}

	return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
		return new ReviewAutoSelectComponent(items, title, autoSelectValue, tui, done, {
			dimColor: (text) => theme.fg("dim", text),
			boldText: (text) => theme.bold(text),
			accentColor: (text) => theme.fg("accent", text),
			warningColor: (text) => theme.fg("warning", text),
			mutedColor: (text) => theme.fg("muted", text),
			timing,
		});
	});
}
