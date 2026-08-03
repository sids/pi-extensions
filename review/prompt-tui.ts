import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { isTuiMode } from "@siddr/pi-shared-qna/extension-mode";
import { CountdownController, formatCountdownLabel } from "./countdown";

export type ReviewPromptCountdownDecision = "submit" | "edit";

export type ReviewPromptCountdownTimingOptions = {
	timeoutMs?: number;
	countdownTickMs?: number;
	now?: () => number;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_COUNTDOWN_TICK_MS = 250;

type TuiComponent = {
	handleInput: (data: string) => void;
	render: (width: number) => string[];
	invalidate: () => void;
	dispose: () => void;
};

class ReviewPromptCountdownComponent implements TuiComponent {
	private readonly prompt: string;
	private readonly title: string;
	private readonly tui: { requestRender: () => void };
	private readonly onDone: (decision: ReviewPromptCountdownDecision) => void;
	private readonly countdown: CountdownController;
	private finished = false;
	private cachedWidth?: number;
	private cachedLines?: string[];

	private dim = (text: string) => text;
	private bold = (text: string) => text;
	private accent = (text: string) => text;
	private warning = (text: string) => text;
	private muted = (text: string) => text;

	constructor(
		prompt: string,
		title: string,
		tui: { requestRender: () => void },
		onDone: (decision: ReviewPromptCountdownDecision) => void,
		options?: {
			dimColor?: (text: string) => string;
			boldText?: (text: string) => string;
			accentColor?: (text: string) => string;
			warningColor?: (text: string) => string;
			mutedColor?: (text: string) => string;
			timing?: ReviewPromptCountdownTimingOptions;
		},
	) {
		this.prompt = prompt;
		this.title = title;
		this.tui = tui;
		this.onDone = onDone;
		this.dim = options?.dimColor ?? this.dim;
		this.bold = options?.boldText ?? this.bold;
		this.accent = options?.accentColor ?? this.accent;
		this.warning = options?.warningColor ?? this.warning;
		this.muted = options?.mutedColor ?? this.muted;
		this.countdown = new CountdownController(
			() => this.finish("submit"),
			() => {
				this.invalidate();
				this.tui.requestRender();
			},
			{
				timeoutMs: options?.timing?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
				countdownTickMs: options?.timing?.countdownTickMs ?? DEFAULT_COUNTDOWN_TICK_MS,
				now: options?.timing?.now,
			},
		);
	}

	private finish(decision: ReviewPromptCountdownDecision): void {
		if (this.finished) {
			return;
		}
		this.finished = true;
		this.countdown.stop();
		this.onDone(decision);
	}

	private getCountdownLabel(): string {
		return formatCountdownLabel(this.countdown.getRemainingMs());
	}

	dispose(): void {
		this.countdown.stop();
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.finish("edit");
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.finish("submit");
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const safeWidth = Math.max(1, width);
		const margin = safeWidth > 1 ? " " : "";
		const lineWidth = Math.max(1, safeWidth - visibleWidth(margin));
		const contentWidth = Math.max(1, lineWidth - 2);
		const padLine = (line: string): string => {
			const truncated = truncateToWidth(line, lineWidth);
			return `${margin}${truncated}${" ".repeat(Math.max(0, lineWidth - visibleWidth(truncated)))}`;
		};
		const wrapMultiline = (text: string): string[] => {
			const wrappedLines: string[] = [];
			for (const part of text.split(/\r?\n/)) {
				const wrappedPart = wrapTextWithAnsi(part, contentWidth);
				wrappedLines.push(...(wrappedPart.length > 0 ? wrappedPart : [""]));
			}
			return wrappedLines;
		};

		const countdownLabel = this.getCountdownLabel();
		const separator = this.muted(" · ");
		const hint = (shortcut: string, action: string) => `${this.bold(shortcut)} ${this.muted(action)}`;
		const lines = [
			"",
			padLine(this.bold(this.title)),
			padLine(this.dim("─".repeat(Math.max(0, lineWidth - 1)))),
			padLine(
				`${this.warning("Submitting in ")}${this.accent(countdownLabel)}${this.warning(". Press Esc to edit instead.")}`,
			),
			padLine(""),
			...wrapMultiline(this.prompt).map((line) => padLine(line)),
			padLine(""),
			padLine(this.dim("─".repeat(Math.max(0, lineWidth - 1)))),
			padLine([
				hint("Enter", "submit now"),
				hint("Esc", "edit"),
				hint("Ctrl+C", "stop auto-submit"),
			].join(separator)),
			padLine(""),
		];

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

export async function runReviewPromptCountdown(
	ctx: ExtensionContext,
	prompt: string,
	title: string,
	timing?: ReviewPromptCountdownTimingOptions,
): Promise<ReviewPromptCountdownDecision> {
	if (!isTuiMode(ctx)) {
		return "edit";
	}

	return ctx.ui.custom<ReviewPromptCountdownDecision>((tui, theme, _keybindings, done) => {
		return new ReviewPromptCountdownComponent(prompt, title, tui, done, {
			dimColor: (text) => theme.fg("dim", text),
			boldText: (text) => theme.bold(text),
			accentColor: (text) => theme.fg("accent", text),
			warningColor: (text) => theme.fg("warning", text),
			mutedColor: (text) => theme.fg("muted", text),
			timing,
		});
	});
}
