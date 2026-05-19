import React, { useMemo } from "react";
import { getSingularPatch, type AnnotationSide, type DiffLineAnnotation, type FileDiffMetadata, type GetHoveredLineResult, type OnDiffLineClickProps } from "@pierre/diffs";
import { FileDiff as PierreFileDiff } from "@pierre/diffs/react";
import type { DiffComment, DiffFileComment, DiffFileEntry, DiffFilePayload, DiffLineComment, DiffViewMode } from "../../types";
import type { DiffLineTarget } from "../app";
import { getCommentSendHint, isCommentSendShortcut } from "../shortcuts";

type LineCommentAnnotation = {
	comment: DiffLineComment;
};

const DIFF_GUTTER_CSS = `
[data-column-number] {
	padding-left: 2.6ch !important;
	position: relative;
}

[data-gutter-utility-slot] {
	left: 0.35ch !important;
	right: auto !important;
	top: 50% !important;
	bottom: auto !important;
	width: 1.25rem !important;
	height: 1.25rem !important;
	align-items: center !important;
	justify-content: center !important;
	transform: translateY(-50%) !important;
}

[data-gutter-utility-slot] > * {
	display: contents !important;
}

[data-gutter-utility-slot] button,
.diff-gutter-with-actions__button {
	display: inline-grid !important;
	place-items: center !important;
	width: 1.25rem !important;
	height: 1.25rem !important;
	margin: 0 !important;
	padding: 0 !important;
	line-height: 1 !important;
	position: relative !important;
}

.diff-gutter-with-actions__icon {
	display: block !important;
	position: absolute !important;
	left: 50% !important;
	top: 50% !important;
	width: 0.72rem !important;
	height: 0.72rem !important;
	transform: translate(-50%, -50%) !important;
}

.diff-gutter-with-actions__icon::before,
.diff-gutter-with-actions__icon::after {
	content: "";
	position: absolute;
	left: 50%;
	top: 50%;
	background: currentColor;
	border-radius: 999px;
	transform: translate(-50%, -50%);
}

.diff-gutter-with-actions__icon::before {
	width: 100%;
	height: 2px;
}

.diff-gutter-with-actions__icon::after {
	width: 2px;
	height: 100%;
}
`;

type FileDiffProps = {
	file: DiffFileEntry;
	payload: DiffFilePayload | null;
	loading: boolean;
	loadError: string | null;
	viewMode: DiffViewMode;
	wrapLines: boolean;
	reviewed: boolean;
	collapsed: boolean;
	expired: boolean;
	comments: DiffComment[];
	onToggleCollapsed: () => void;
	onToggleReviewed: () => void;
	onAddFileComment: () => void;
	onCreateLineComment: (target: DiffLineTarget) => void;
	onCommentTextChange: (commentId: string, text: string) => void;
	onRemoveComment: (commentId: string) => void;
	onToggleCommentCollapsed: (commentId: string) => void;
	isCommentCollapsed: (commentId: string) => boolean;
	registerCommentTextarea: (commentId: string, element: HTMLTextAreaElement | null) => void;
	onSendComment: (commentId: string) => void;
};

function collectLineComments(comments: DiffComment[]): DiffLineComment[] {
	return comments.filter((comment): comment is DiffLineComment => comment.kind === "line");
}

function collectFileComments(comments: DiffComment[]): DiffFileComment[] {
	return comments.filter((comment): comment is DiffFileComment => comment.kind === "file");
}

function renderChevron(collapsed: boolean) {
	return <span className={`chevron ${collapsed ? "is-collapsed" : "is-expanded"}`}>❯</span>;
}

function mapCommentSide(side: DiffLineComment["side"]): AnnotationSide {
	return side === "old" ? "deletions" : "additions";
}

function mapAnnotationSide(side: AnnotationSide): DiffLineComment["side"] {
	return side === "deletions" ? "old" : "new";
}

function resolveDiffLineTarget(fileDiff: FileDiffMetadata, side: DiffLineComment["side"], lineNumber: number): DiffLineTarget {
	const annotationSide = mapCommentSide(side);
	for (const [hunkIndex, hunk] of fileDiff.hunks.entries()) {
		let additionLine = hunk.additionStart;
		let deletionLine = hunk.deletionStart;
		for (const [contentIndex, content] of hunk.hunkContent.entries()) {
			if (content.type === "context") {
				const containsLine =
					lineNumber >= (side === "new" ? additionLine : deletionLine) && lineNumber < (side === "new" ? additionLine : deletionLine) + content.lines;
				if (containsLine) {
					const lineIndex = (annotationSide === "additions" ? content.additionLineIndex : content.deletionLineIndex) + lineNumber - (side === "new" ? additionLine : deletionLine);
					return {
						lineNumber,
						side,
						changeKey: `${side}:${lineNumber}:h${hunkIndex}:c${contentIndex}`,
						excerpt: (annotationSide === "additions" ? fileDiff.additionLines[lineIndex] : fileDiff.deletionLines[lineIndex])?.trim(),
					};
				}
				additionLine += content.lines;
				deletionLine += content.lines;
				continue;
			}

			if (side === "new") {
				const containsLine = lineNumber >= additionLine && lineNumber < additionLine + content.additions;
				if (containsLine) {
					const lineIndex = content.additionLineIndex + lineNumber - additionLine;
					return {
						lineNumber,
						side,
						changeKey: `${side}:${lineNumber}:h${hunkIndex}:c${contentIndex}`,
						excerpt: fileDiff.additionLines[lineIndex]?.trim(),
					};
				}
			} else {
				const containsLine = lineNumber >= deletionLine && lineNumber < deletionLine + content.deletions;
				if (containsLine) {
					const lineIndex = content.deletionLineIndex + lineNumber - deletionLine;
					return {
						lineNumber,
						side,
						changeKey: `${side}:${lineNumber}:h${hunkIndex}:c${contentIndex}`,
						excerpt: fileDiff.deletionLines[lineIndex]?.trim(),
					};
				}
			}
			additionLine += content.additions;
			deletionLine += content.deletions;
		}
	}
	return {
		lineNumber,
		side,
		changeKey: `${side}:${lineNumber}`,
	};
}

function parseFileDiff(payload: DiffFilePayload | null): FileDiffMetadata | null {
	if (!payload?.diffText) {
		return null;
	}
	try {
		return getSingularPatch(payload.diffText);
	} catch {
		return null;
	}
}

export function getFileDetailText(file: DiffFileEntry): string | null {
	if (file.status === "renamed" && file.oldPath && file.newPath && file.oldPath !== file.newPath) {
		return `${file.oldPath} → ${file.newPath}`;
	}
	return null;
}

function renderCommentEditor(
	comment: DiffComment,
	expired: boolean,
	collapsed: boolean,
	onCommentTextChange: (commentId: string, text: string) => void,
	onRemoveComment: (commentId: string) => void,
	onToggleCommentCollapsed: (commentId: string) => void,
	onSendComment: (commentId: string) => void,
	registerCommentTextarea: (commentId: string, element: HTMLTextAreaElement | null) => void,
) {
	const sendHint = getCommentSendHint();
	const canSend = !expired && comment.sentAt === null && comment.text.trim().length > 0;
	const preview = comment.text.trim();
	if (collapsed) {
		return (
			<div className="comment-card comment-card--collapsed" key={comment.id}>
				<button
					aria-label="Remove comment"
					className="comment-card__remove"
					onClick={(event) => {
						event.stopPropagation();
						onRemoveComment(comment.id);
					}}
					type="button"
				>
					×
				</button>
				<button className="comment-card__collapsed" onClick={() => onToggleCommentCollapsed(comment.id)} type="button">
					<span className="comment-card__collapsed-chevron">{renderChevron(true)}</span>
					<span className="comment-card__preview-text">{preview}</span>
				</button>
			</div>
		);
	}
	return (
		<div className="comment-card" key={comment.id}>
			<button
				aria-label="Remove comment"
				className="comment-card__remove"
				onClick={() => onRemoveComment(comment.id)}
				type="button"
			>
				×
			</button>
			<div className="comment-card__header">
				<div className="comment-card__title-row">
					<button className="comment-card__toggle" onClick={() => onToggleCommentCollapsed(comment.id)} type="button">
						{renderChevron(false)}
					</button>
					<div className="comment-card__meta-group">
						<div className="comment-card__meta">{comment.sentAt ? "Sent" : "Draft"}</div>
					</div>
				</div>
			</div>
			<textarea
				ref={(element) => registerCommentTextarea(comment.id, element)}
				value={comment.text}
				placeholder="Write a comment"
				onChange={(event) => onCommentTextChange(comment.id, event.target.value)}
				onKeyDown={(event) => {
					if (!isCommentSendShortcut(event)) {
						return;
					}
					event.preventDefault();
					void onSendComment(comment.id);
				}}
			/>
			<div className="comment-card__footer">
				<div className="comment-card__actions">
					<button className="comment-card__send button-with-shortcut" disabled={!canSend} onClick={() => void onSendComment(comment.id)} type="button">
						{comment.sentAt ? (
							<span>Sent</span>
						) : (
							<>
								<span>Send</span>
								<span className="shortcut-chip">{sendHint}</span>
							</>
						)}
					</button>
				</div>
			</div>
		</div>
	);
}

export function FileDiff(props: FileDiffProps) {
	const fileComments = collectFileComments(props.comments);
	const lineComments = collectLineComments(props.comments);
	const parsedFile = useMemo(() => parseFileDiff(props.payload), [props.payload]);
	const lineAnnotations = useMemo<DiffLineAnnotation<LineCommentAnnotation>[]>(
		() =>
			lineComments.map((comment) => ({
				lineNumber: comment.lineNumber,
				side: mapCommentSide(comment.side),
				metadata: { comment },
			})),
		[lineComments],
	);
	const fileDetailText = getFileDetailText(props.file);

	const createCommentForLine = (lineNumber: number, annotationSide: AnnotationSide) => {
		if (!parsedFile) {
			return;
		}
		const side = mapAnnotationSide(annotationSide);
		props.onCreateLineComment(resolveDiffLineTarget(parsedFile, side, lineNumber));
	};

	return (
		<section className={`file-section file-section--${props.file.status} ${props.collapsed ? "is-collapsed" : ""}`} id={props.file.anchorId}>
			<header className="file-section__header" onClick={props.onToggleCollapsed}>
				<div className="file-section__summary">
					<div className="file-section__main">
						<div className="file-section__title-row">
							<div className="file-section__chevron">{renderChevron(props.collapsed)}</div>
							<div className="file-section__path">{props.file.path}</div>
						</div>
						{fileDetailText ? <div className="file-section__rename">{fileDetailText}</div> : null}
					</div>
				</div>
				<div className="file-section__actions">
					<label
						className="checkbox-control"
						onClick={(event) => {
							event.stopPropagation();
						}}
					>
						<input checked={props.reviewed} onChange={props.onToggleReviewed} type="checkbox" />
						<span>Viewed</span>
					</label>
					<button
						aria-label="Add file comment"
						className="file-section__comment-button"
						onClick={(event) => {
							event.stopPropagation();
							props.onAddFileComment();
						}}
						title="Add file comment"
						type="button"
					>
						<svg aria-hidden="true" className="file-section__comment-icon" viewBox="0 0 16 16">
							<path
								d="M3.25 3.5h9.5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H8.2L5.4 12.75v-2.25H3.25a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1Z"
								fill="none"
								stroke="currentColor"
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth="1.35"
							/>
						</svg>
					</button>
				</div>
			</header>

			{!props.collapsed && fileComments.length > 0 ? (
				<div className="file-comment-list">
					{fileComments.map((comment) =>
						renderCommentEditor(
							comment,
							props.expired,
							props.isCommentCollapsed(comment.id),
							props.onCommentTextChange,
							props.onRemoveComment,
							props.onToggleCommentCollapsed,
							props.onSendComment,
							props.registerCommentTextarea,
						),
					)}
				</div>
			) : null}

			{!props.collapsed && props.loading ? <div className="file-section__empty">Loading diff…</div> : null}
			{!props.collapsed && props.loadError ? <div className="file-section__empty file-section__empty--error">{props.loadError}</div> : null}
			{!props.collapsed && !props.loading && !props.loadError && props.payload?.file.isBinary ? (
				<div className="file-section__empty">{props.payload.message ?? "Binary or unrenderable file"}</div>
			) : null}
			{!props.collapsed && !props.loading && !props.loadError && parsedFile ? (
				<div className={`file-diff ${props.wrapLines ? "is-wrapped" : ""}`}>
					<PierreFileDiff<LineCommentAnnotation>
						fileDiff={parsedFile}
						lineAnnotations={lineAnnotations}
						options={{
							diffStyle: props.viewMode,
							overflow: props.wrapLines ? "wrap" : "scroll",
							theme: "pierre-dark",
							hunkSeparators: "line-info-basic",
							lineHoverHighlight: "both",
							enableGutterUtility: true,
							unsafeCSS: DIFF_GUTTER_CSS,
							onLineNumberClick: (line: OnDiffLineClickProps) => createCommentForLine(line.lineNumber, line.annotationSide),
						}}
						renderAnnotation={(annotation) =>
							renderCommentEditor(
								annotation.metadata.comment,
								props.expired,
								props.isCommentCollapsed(annotation.metadata.comment.id),
								props.onCommentTextChange,
								props.onRemoveComment,
								props.onToggleCommentCollapsed,
								props.onSendComment,
								props.registerCommentTextarea,
							)
						}
						renderGutterUtility={(getHoveredLine: () => GetHoveredLineResult<"diff"> | undefined) => {
							const hoveredLine = getHoveredLine();
							const addCommentForHoveredLine = () => {
								const line = hoveredLine ?? getHoveredLine();
								if (line) {
									createCommentForLine(line.lineNumber, line.side);
								}
							};
							return (
								<button
									aria-disabled={!hoveredLine}
									aria-label="Add line comment"
									className="diff-gutter-with-actions__button"
									title="Add line comment"
									onClick={(event) => {
										event.preventDefault();
										event.stopPropagation();
									}}
									onPointerDown={(event) => {
										event.preventDefault();
										event.stopPropagation();
										addCommentForHoveredLine();
									}}
									type="button"
								>
									<span aria-hidden="true" className="diff-gutter-with-actions__icon" />
								</button>
							);
						}}
					/>
				</div>
			) : null}
			{!props.collapsed && !props.loading && !props.loadError && !props.payload && <div className="file-section__empty">Diff content unavailable.</div>}
		</section>
	);
}
