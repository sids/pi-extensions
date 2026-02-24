import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ReviewComment, ReviewPriority, ReviewTriageResult, TriagedReviewComment } from "./types";
import { toTriagedReviewComment } from "./utils";

const require = createRequire(import.meta.url);

function requirePiTui() {
	try {
		return require("@mariozechner/pi-tui");
	} catch (error) {
		const code = (error as { code?: string }).code;
		if (code !== "MODULE_NOT_FOUND") {
			throw error;
		}
		return require(path.join(os.homedir(), ".bun", "install", "global", "node_modules", "@mariozechner", "pi-tui"));
	}
}

function getPiTui() {
	return requirePiTui() as {
		Editor: new (
			tui: { requestRender: () => void },
			theme: {
				borderColor: (text: string) => string;
				selectList: {
					matchHighlight?: (text: string) => string;
					itemSecondary?: (text: string) => string;
				};
			},
		) => {
			disableSubmit?: boolean;
			onChange?: () => void;
			setText: (text: string) => void;
			getText: () => string;
			render: (width: number) => string[];
			handleInput: (data: string) => void;
		};
		Key: {
			enter: string;
			tab: string;
			escape: string;
			ctrl: (key: string) => string;
			shift: (key: string) => string;
			alt: (key: string) => string;
		};
		matchesKey: (input: string, key: string) => boolean;
		truncateToWidth: (text: string, width: number) => string;
		visibleWidth: (text: string) => number;
		wrapTextWithAnsi: (text: string, width: number) => string[];
	};
}

export const PRIORITY_SHORTCUTS: Record<string, ReviewPriority> = {
	"0": "P0",
	"1": "P1",
	"2": "P2",
	"3": "P3",
};

const PRIORITY_SHORTCUT_ALIASES: Record<string, string> = {
	"^0": "0",
	"^1": "1",
	"^2": "2",
	"^3": "3",
	"\u001b[48;5u": "0",
	"\u001b[49;5u": "1",
	"\u001b[50;5u": "2",
	"\u001b[51;5u": "3",
	"\u001b[27;5;48~": "0",
	"\u001b[27;5;49~": "1",
	"\u001b[27;5;50~": "2",
	"\u001b[27;5;51~": "3",
};

export function resolvePriorityShortcutInput(data: string): ReviewPriority | undefined {
	const normalized = PRIORITY_SHORTCUT_ALIASES[data];
	if (!normalized) {
		return undefined;
	}
	return PRIORITY_SHORTCUTS[normalized];
}

export function createInitialTriageComments(comments: ReviewComment[]): TriagedReviewComment[] {
	return comments.map((comment) => ({
		...toTriagedReviewComment(comment),
		note: "",
	}));
}

export function applyPriorityShortcut(priorityShortcut: string, current: ReviewPriority): ReviewPriority {
	return PRIORITY_SHORTCUTS[priorityShortcut] ?? current;
}

export function normalizeReviewerNote(note: string): string | undefined {
	const trimmed = note.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export function buildReviewTriageResult(comments: TriagedReviewComment[]): ReviewTriageResult {
	const normalized = comments.map((comment) => ({
		...comment,
		note: normalizeReviewerNote(comment.note ?? ""),
	}));
	const keptCount = normalized.filter((comment) => comment.keep).length;
	return {
		comments: normalized,
		keptCount,
		discardedCount: normalized.length - keptCount,
	};
}

type TuiComponent = {
	handleInput: (data: string) => void;
	render: (width: number) => string[];
	invalidate: () => void;
};

class ReviewTriageComponent implements TuiComponent {
	private comments: TriagedReviewComment[];
	private currentIndex = 0;
	private showingConfirmation = false;
	private editor: {
		disableSubmit?: boolean;
		onChange?: () => void;
		setText: (text: string) => void;
		getText: () => string;
		render: (width: number) => string[];
		handleInput: (data: string) => void;
	};
	private tui: { requestRender: () => void };
	private onDone: (result: ReviewTriageResult | null) => void;
	private titleHint?: string;

	private cachedWidth?: number;
	private cachedLines?: string[];

	private dim = (s: string) => s;
	private bold = (s: string) => s;
	private accent = (s: string) => s;
	private success = (s: string) => s;
	private warning = (s: string) => s;
	private muted = (s: string) => s;

	constructor(
		comments: TriagedReviewComment[],
		tui: { requestRender: () => void },
		onDone: (result: ReviewTriageResult | null) => void,
		options?: {
			titleHint?: string;
			accentColor?: (text: string) => string;
			successColor?: (text: string) => string;
			warningColor?: (text: string) => string;
			mutedColor?: (text: string) => string;
			dimColor?: (text: string) => string;
			boldText?: (text: string) => string;
		},
	) {
		this.comments = comments;
		this.tui = tui;
		this.onDone = onDone;
		this.titleHint = options?.titleHint;
		this.accent = options?.accentColor ?? this.accent;
		this.success = options?.successColor ?? this.success;
		this.warning = options?.warningColor ?? this.warning;
		this.muted = options?.mutedColor ?? this.muted;
		this.dim = options?.dimColor ?? this.dim;
		this.bold = options?.boldText ?? this.bold;

		const { Editor } = getPiTui();
		this.editor = new Editor(tui, {
			borderColor: this.dim,
			selectList: {
				matchHighlight: this.accent,
				itemSecondary: this.muted,
			},
		});
		this.editor.disableSubmit = true;
		this.editor.onChange = () => {
			this.saveCurrentNote();
			this.invalidate();
			this.tui.requestRender();
		};
		this.loadCurrentNote();
	}

	private getCurrent(): TriagedReviewComment | undefined {
		return this.comments[this.currentIndex];
	}

	private saveCurrentNote(): void {
		const current = this.getCurrent();
		if (!current) {
			return;
		}
		current.note = this.editor.getText();
	}

	private loadCurrentNote(): void {
		const current = this.getCurrent();
		this.editor.setText(current?.note ?? "");
	}

	private move(delta: number): void {
		if (this.comments.length === 0) {
			return;
		}
		this.saveCurrentNote();
		const nextIndex = this.currentIndex + delta;
		this.currentIndex = Math.max(0, Math.min(this.comments.length - 1, nextIndex));
		this.loadCurrentNote();
		this.showingConfirmation = false;
		this.invalidate();
		this.tui.requestRender();
	}

	private toggleKeep(): void {
		const current = this.getCurrent();
		if (!current) {
			return;
		}
		current.keep = !current.keep;
		this.showingConfirmation = false;
		this.invalidate();
		this.tui.requestRender();
	}

	private setPriority(priority: ReviewPriority): void {
		const current = this.getCurrent();
		if (!current || current.priority === priority) {
			return;
		}
		current.priority = priority;
		this.showingConfirmation = false;
		this.invalidate();
		this.tui.requestRender();
	}

	private resolvePriorityFromInput(data: string): ReviewPriority | undefined {
		const { Key, matchesKey } = getPiTui();
		if (matchesKey(data, Key.ctrl("0"))) {
			return "P0";
		}
		if (matchesKey(data, Key.ctrl("1"))) {
			return "P1";
		}
		if (matchesKey(data, Key.ctrl("2"))) {
			return "P2";
		}
		if (matchesKey(data, Key.ctrl("3"))) {
			return "P3";
		}
		return resolvePriorityShortcutInput(data);
	}

	private formatReferenceLabel(reference: { filePath: string; startLine: number; endLine?: number }): string {
		return reference.endLine
			? `${reference.filePath}:${reference.startLine}-${reference.endLine}`
			: `${reference.filePath}:${reference.startLine}`;
	}

	private submit(): void {
		this.saveCurrentNote();
		this.onDone(buildReviewTriageResult(this.comments));
	}

	invalidate(): void {
		this.cachedLines = undefined;
		this.cachedWidth = undefined;
	}

	handleInput(data: string): void {
		const { Key, matchesKey } = getPiTui();

		if (matchesKey(data, Key.ctrl("c"))) {
			this.onDone(null);
			return;
		}

		if (this.comments.length === 0) {
			if (matchesKey(data, Key.enter)) {
				this.submit();
			}
			return;
		}

		if (this.showingConfirmation) {
			if (matchesKey(data, Key.enter)) {
				this.submit();
				return;
			}
			if (matchesKey(data, Key.escape)) {
				this.showingConfirmation = false;
				this.invalidate();
				this.tui.requestRender();
			}
			return;
		}

		if (matchesKey(data, Key.tab)) {
			this.move(1);
			return;
		}

		if (matchesKey(data, Key.shift("tab"))) {
			this.move(-1);
			return;
		}

		if (matchesKey(data, Key.alt("enter"))) {
			this.toggleKeep();
			return;
		}

		const nextPriority = this.resolvePriorityFromInput(data);
		if (nextPriority) {
			this.setPriority(nextPriority);
			return;
		}

		if (matchesKey(data, Key.enter) && !matchesKey(data, Key.shift("enter"))) {
			if (this.currentIndex >= this.comments.length - 1) {
				this.saveCurrentNote();
				this.showingConfirmation = true;
				this.invalidate();
				this.tui.requestRender();
				return;
			}
			this.move(1);
			return;
		}

		this.editor.handleInput(data);
		this.showingConfirmation = false;
		this.invalidate();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const { truncateToWidth, wrapTextWithAnsi, visibleWidth } = getPiTui();
		const lines: string[] = [];
		const safeWidth = Math.max(40, width);
		const margin = " ";
		const lineWidth = Math.max(20, safeWidth - visibleWidth(margin));
		const contentWidth = Math.max(20, lineWidth - 2);
		const padLine = (line: string): string => {
			const truncated = truncateToWidth(line, lineWidth);
			return `${margin}${truncated}${" ".repeat(Math.max(0, lineWidth - visibleWidth(truncated)))}`;
		};
		const wrapMultiline = (text: string, maxWidth: number): string[] => {
			const wrappedLines: string[] = [];
			for (const part of text.split(/\r?\n/)) {
				const wrappedPart = wrapTextWithAnsi(part, Math.max(1, maxWidth));
				if (wrappedPart.length === 0) {
					wrappedLines.push("");
					continue;
				}
				wrappedLines.push(...wrappedPart);
			}
			return wrappedLines;
		};

		lines.push("");
		if (this.comments.length === 0) {
			lines.push(padLine("No review comments were collected for this run."));
			lines.push(padLine(this.dim("Press Enter to confirm or Ctrl+C to cancel.")));
			lines.push(padLine(""));
			this.cachedLines = lines;
			this.cachedWidth = width;
			return lines;
		}

		const heading = this.bold(this.showingConfirmation ? "Confirm review submission" : "Review Triage");
		if (this.titleHint?.trim()) {
			lines.push(padLine(`${heading}${this.dim(` · Target: ${this.titleHint.trim()}`)}`));
		} else {
			lines.push(padLine(heading));
		}
		lines.push(padLine(this.dim("─".repeat(Math.max(0, lineWidth - 1)))));

		const separator = this.muted(" · ");
		const hint = (shortcut: string, action: string) => `${this.bold(shortcut)} ${this.muted(action)}`;

		if (this.showingConfirmation) {
			const triage = buildReviewTriageResult(this.comments);
			const keptComments = triage.comments.filter((comment) => comment.keep);
			lines.push(padLine(this.muted(`Kept: ${triage.keptCount} • Discarded: ${triage.discardedCount}`)));
			lines.push(padLine(""));

			if (keptComments.length === 0) {
				lines.push(padLine(this.muted("No kept comments to submit.")));
			} else {
				for (let i = 0; i < keptComments.length; i++) {
					const comment = keptComments[i];
					const wrappedCommentLines = wrapMultiline(
						`${i + 1}. ${this.accent(`[${comment.priority}]`)} ${comment.comment}`,
						contentWidth,
					);
					for (const line of wrappedCommentLines) {
						lines.push(padLine(line));
					}

					if (comment.references.length > 0) {
						lines.push(padLine(this.muted("   References:")));
						for (const reference of comment.references) {
							lines.push(padLine(this.dim(`   - ${this.formatReferenceLabel(reference)}`)));
						}
					}

					if (comment.note?.trim()) {
						const notePrefix = "   Note: ";
						const wrappedNoteLines = wrapMultiline(
							comment.note.trim(),
							Math.max(10, contentWidth - visibleWidth(notePrefix)),
						);
						if (wrappedNoteLines.length === 0) {
							lines.push(padLine(this.muted(notePrefix.trimEnd())));
						} else {
							lines.push(padLine(`${this.muted(notePrefix)}${wrappedNoteLines[0]}`));
							const noteContinuation = " ".repeat(visibleWidth(notePrefix));
							for (let noteIndex = 1; noteIndex < wrappedNoteLines.length; noteIndex++) {
								lines.push(padLine(`${noteContinuation}${wrappedNoteLines[noteIndex]}`));
							}
						}
					}

					if (i < keptComments.length - 1) {
						lines.push(padLine(""));
					}
				}
			}

			lines.push(padLine(this.dim("─".repeat(Math.max(0, lineWidth - 1)))));
			const confirmControls = [
				hint("Enter", "confirm"),
				hint("Esc", "back"),
				hint("Ctrl+C", "cancel"),
			].join(separator);
			lines.push(padLine(confirmControls));
			lines.push(padLine(""));
			this.cachedLines = lines;
			this.cachedWidth = width;
			return lines;
		}

		const current = this.getCurrent();
		if (!current) {
			this.cachedLines = lines;
			this.cachedWidth = width;
			return lines;
		}

		const progressParts = this.comments.map((comment, index) => {
			if (index === this.currentIndex) {
				return this.accent("●");
			}
			return comment.keep ? this.success("●") : this.warning("○");
		});
		lines.push(padLine(progressParts.join(" ")));

		const status = current.keep ? this.success("keep") : this.warning("discard");

		for (const line of wrapMultiline(`${this.accent(`[${current.priority}]`)} ${current.comment}`, contentWidth)) {
			lines.push(padLine(line));
		}

		if (current.references.length > 0) {
			lines.push(padLine(this.muted("References:")));
			for (const reference of current.references) {
				lines.push(padLine(this.dim(`- ${this.formatReferenceLabel(reference)}`)));
			}
			lines.push(padLine(""));
		}

		lines.push(padLine(`${status} ${this.muted("•")} ${this.accent(current.priority)} ${this.muted("• Note:")}`));
		const editorLines = this.editor.render(Math.max(20, contentWidth));
		for (let i = 1; i < editorLines.length - 1; i++) {
			lines.push(padLine(editorLines[i]));
		}

		lines.push(padLine(this.dim("─".repeat(Math.max(0, lineWidth - 1)))));
		const controls = [
			hint("Tab/⇧Tab", "next/prev"),
			hint("Ctrl+0..3", "priority"),
			hint("Alt+Enter", "toggle keep"),
			hint("Enter", "next/confirm on last"),
			hint("Ctrl+C", "cancel"),
		].join(separator);
		lines.push(padLine(controls));
		lines.push(padLine(""));

		this.cachedLines = lines;
		this.cachedWidth = width;
		return lines;
	}
}

export async function runReviewTriage(
	ctx: ExtensionContext,
	comments: ReviewComment[],
	targetHint?: string,
): Promise<ReviewTriageResult | null> {
	if (!ctx.hasUI) {
		return null;
	}

	const triageComments = createInitialTriageComments(comments);
	return ctx.ui.custom<ReviewTriageResult | null>((tui, theme, _kb, done) => {
		return new ReviewTriageComponent(triageComments, tui, done, {
			titleHint: targetHint,
			accentColor: (text) => theme.fg("accent", text),
			successColor: (text) => theme.fg("success", text),
			warningColor: (text) => theme.fg("warning", text),
			mutedColor: (text) => theme.fg("muted", text),
			dimColor: (text) => theme.fg("dim", text),
			boldText: (text) => theme.bold(text),
		});
	});
}
