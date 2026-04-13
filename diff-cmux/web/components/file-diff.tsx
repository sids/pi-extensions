import React, { useMemo } from "react";
import { Diff, Hunk, parseDiff, type ChangeData, type DiffType } from "react-diff-view";
import type { DiffComment, DiffFileComment, DiffFileEntry, DiffFilePayload, DiffLineComment, DiffViewMode } from "../../types";
import { getCommentSendHint, isCommentSendShortcut } from "../shortcuts";

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
	onCreateLineComment: (change: ChangeData, side: "old" | "new") => void;
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

function getDiffType(payload: DiffFilePayload | null): DiffType {
	switch (payload?.file.status) {
		case "added":
			return "add";
		case "deleted":
			return "delete";
		case "renamed":
			return "rename";
		default:
			return "modify";
	}
}

export function getFileDetailText(file: DiffFileEntry): string | null {
	if (file.status === "renamed" && file.oldPath && file.newPath && file.oldPath !== file.newPath) {
		return `${file.oldPath} → ${file.newPath}`;
	}
	return null;
}

function renderChevron(collapsed: boolean) {
	return <span className={`chevron ${collapsed ? "is-collapsed" : "is-expanded"}`}>❯</span>;
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
	const parsedFile = useMemo(() => {
		if (!props.payload?.diffText) {
			return null;
		}
		return parseDiff(props.payload.diffText, { nearbySequences: "zip" })[0] ?? null;
	}, [props.payload?.diffText]);
	const widgets = useMemo(() => {
		return lineComments.reduce<Record<string, React.ReactNode>>((allWidgets, comment) => {
			const existing = allWidgets[comment.changeKey];
			allWidgets[comment.changeKey] = (
				<div className="line-comment-widget">
					{existing}
					{renderCommentEditor(
						comment,
						props.expired,
						props.isCommentCollapsed(comment.id),
						props.onCommentTextChange,
						props.onRemoveComment,
						props.onToggleCommentCollapsed,
						props.onSendComment,
						props.registerCommentTextarea,
					)}
				</div>
			);
			return allWidgets;
		}, {});
	}, [
		lineComments,
		props.expired,
		props.isCommentCollapsed,
		props.onCommentTextChange,
		props.onRemoveComment,
		props.onToggleCommentCollapsed,
		props.onSendComment,
		props.registerCommentTextarea,
	]);

	const fileDetailText = getFileDetailText(props.file);

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
					<Diff
						diffType={getDiffType(props.payload)}
						hunks={parsedFile.hunks}
						viewType={props.viewMode}
						widgets={widgets}
						renderGutter={({ change, side, renderDefault, wrapInAnchor }) => (
							<div className="diff-gutter-with-actions">
								<span className="diff-gutter-with-actions__line">{wrapInAnchor(renderDefault())}</span>
								<button
									className="diff-gutter-with-actions__button"
									onClick={(event) => {
										event.preventDefault();
										event.stopPropagation();
										props.onCreateLineComment(change, side);
									}}
								>
									+
								</button>
							</div>
						)}
					>
						{(hunks) => hunks.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)}
					</Diff>
				</div>
			) : null}
			{!props.collapsed && !props.loading && !props.loadError && !props.payload && <div className="file-section__empty">Diff content unavailable.</div>}
		</section>
	);
}
