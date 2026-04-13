import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getChangeKey, type ChangeData } from "react-diff-view";
import { findReusableDraftComment, removeCommentById, updateCommentText } from "../comments";
import type { DiffComment, DiffFileEntry, DiffFilePayload, DiffLineComment, DiffOverallComment, DiffViewMode, SendCommentsResponse, ViewerBootstrapPayload } from "../types";
import { filterFilesByQuery } from "./search";
import { getAppLayoutClassName } from "./layout";
import { ensureCollapsedStateForOverallComments } from "./overall-comments";
import { loadViewerState, saveViewerState } from "./storage";
import { getCommentSendHint, isCommentSendShortcut, isFocusSearchShortcut, isRefreshShortcut, isSendAllShortcut } from "./shortcuts";
import { buildViewedFingerprintsByFileId, getInvalidatedReviewedFileIds, getNextReviewedToggleState, reconcileReviewedByFileId } from "./reviewed";
import { FileDiff } from "./components/file-diff";
import { Sidebar } from "./components/sidebar";
import { Toolbar } from "./components/toolbar";

type AppProps = {
	viewerToken: string;
};

function createCommentId(prefix: string) {
	return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function createOverallDraftComment(): DiffOverallComment {
	const now = Date.now();
	return {
		id: createCommentId("overall"),
		kind: "overall",
		text: "",
		createdAt: now,
		updatedAt: now,
		sentAt: null,
	};
}

function normalizeOverallComments(currentComments: DiffComment[]): DiffComment[] {
	const overallComments = currentComments.filter((comment): comment is DiffOverallComment => comment.kind === "overall");
	if (overallComments.length === 1) {
		return currentComments;
	}

	const scopedComments = currentComments.filter((comment) => comment.kind !== "overall");
	if (overallComments.length === 0) {
		return [...scopedComments, createOverallDraftComment()];
	}

	const [firstComment, ...restComments] = overallComments;
	const mergedText = overallComments
		.map((comment) => comment.text.trim())
		.filter((text) => text.length > 0)
		.join("\n\n");
	const mergedComment: DiffOverallComment = {
		...firstComment,
		text: mergedText || firstComment.text,
		updatedAt: Math.max(...overallComments.map((comment) => comment.updatedAt)),
		sentAt: restComments.some((comment) => comment.sentAt === null) ? null : firstComment.sentAt,
	};
	return [...scopedComments, mergedComment];
}

function renderChevron(collapsed: boolean) {
	return <span className={`chevron ${collapsed ? "is-collapsed" : "is-expanded"}`}>❯</span>;
}

function extractExcerpt(change: ChangeData): string {
	return change.content.replace(/^[ +\-]/, "").trim();
}

function resolveLineNumber(change: ChangeData, side: "old" | "new"): number | null {
	if (change.type === "normal") {
		return side === "old" ? change.oldLineNumber : change.newLineNumber;
	}
	if (change.type === "delete") {
		return side === "old" ? change.lineNumber : null;
	}
	if (change.type === "insert") {
		return side === "new" ? change.lineNumber : null;
	}
	return null;
}

function isEditableElement(target: EventTarget | null): target is HTMLInputElement | HTMLTextAreaElement {
	return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
	const response = await fetch(url, init);
	if (!response.ok) {
		const errorBody = await response.json().catch(() => ({ error: response.statusText }));
		throw new Error(typeof errorBody?.error === "string" ? errorBody.error : response.statusText);
	}
	return await response.json();
}

export function App({ viewerToken }: AppProps) {
	const initialStoredState = useMemo(() => loadViewerState(viewerToken), [viewerToken]);
	const [bootstrap, setBootstrap] = useState<ViewerBootstrapPayload | null>(null);
	const [expired, setExpired] = useState(false);
	const [bootstrapError, setBootstrapError] = useState<string | null>(null);
	const initialComments = useMemo(() => normalizeOverallComments(initialStoredState.comments), [initialStoredState.comments]);
	const [sidebarCollapsed, setSidebarCollapsed] = useState(initialStoredState.sidebarCollapsed);
	const [searchQuery, setSearchQuery] = useState(initialStoredState.searchQuery);
	const [wrapLines, setWrapLines] = useState(initialStoredState.wrapLines);
	const [reviewedByFileId, setReviewedByFileId] = useState<Record<string, boolean>>(initialStoredState.reviewedByFileId);
	const [comments, setComments] = useState<DiffComment[]>(initialComments);
	const [collapsedFileIds, setCollapsedFileIds] = useState<Record<string, boolean>>(() => ({
		...Object.fromEntries(
			Object.entries(initialStoredState.reviewedByFileId)
				.filter(([, reviewed]) => reviewed)
				.map(([fileId]) => [fileId, true]),
		),
		...initialStoredState.collapsedFileIds,
	}));
	const [collapsedCommentIds, setCollapsedCommentIds] = useState<Record<string, boolean>>(() =>
		ensureCollapsedStateForOverallComments(initialStoredState.collapsedCommentIds, initialComments),
	);
	const [viewModeOverride, setViewModeOverride] = useState<DiffViewMode | null>(initialStoredState.viewMode);
	const [loadedFiles, setLoadedFiles] = useState<Record<string, DiffFilePayload>>({});
	const [loadErrors, setLoadErrors] = useState<Record<string, string>>({});
	const [loadingFileIds, setLoadingFileIds] = useState<Record<string, boolean>>({});
	const [activeFileId, setActiveFileId] = useState<string | null>(null);
	const [focusCommentId, setFocusCommentId] = useState<string | null>(null);
	const fileSectionRefs = useRef<Record<string, HTMLElement | null>>({});
	const commentTextareaRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
	const searchInputRef = useRef<HTMLInputElement | null>(null);
	const overallCommentsRef = useRef<HTMLElement | null>(null);
	const commentSendHint = useMemo(() => getCommentSendHint(), []);
	const [focusSearchRequested, setFocusSearchRequested] = useState(false);
	const [sidebarPopoverOpen, setSidebarPopoverOpen] = useState(false);
	const [isNarrowViewport, setIsNarrowViewport] = useState(() =>
		typeof window !== "undefined" ? window.matchMedia("(max-width: 1000px)").matches : false,
	);

	const viewMode = viewModeOverride ?? bootstrap?.defaultViewMode ?? "unified";
	const files = bootstrap?.files ?? [];
	const sidebarOverlayMode = isNarrowViewport;
	const sidebarVisible = sidebarOverlayMode ? sidebarPopoverOpen : true;
	const sidebarCollapsedState = sidebarOverlayMode ? false : sidebarCollapsed;
	const visibleSidebarFiles = useMemo(() => filterFilesByQuery(files, searchQuery), [files, searchQuery]);
	const currentViewedFingerprintsByFileId = useMemo(() => buildViewedFingerprintsByFileId(files), [files]);
	const unsentComments = useMemo(() => comments.filter((comment) => comment.sentAt === null && comment.text.trim().length > 0), [comments]);
	const commentCounts = useMemo(() => {
		return comments.reduce<Record<string, { unsent: number; sent: number }>>((counts, comment) => {
			if (comment.kind === "overall") {
				return counts;
			}
			const entry = counts[comment.fileId] ?? { unsent: 0, sent: 0 };
			if (comment.sentAt) {
				entry.sent += 1;
			} else if (comment.text.trim()) {
				entry.unsent += 1;
			}
			counts[comment.fileId] = entry;
			return counts;
		}, {});
	}, [comments]);

	useEffect(() => {
		let cancelled = false;
		void fetchJson<ViewerBootstrapPayload>(`/api/viewer/${viewerToken}`)
			.then((payload) => {
				if (cancelled) {
					return;
				}
				const nextReviewedByFileId = reconcileReviewedByFileId(
					initialStoredState.reviewedByFileId,
					initialStoredState.viewedFingerprintsByFileId,
					payload.files,
				);
				const invalidatedReviewedFileIds = getInvalidatedReviewedFileIds(
					initialStoredState.reviewedByFileId,
					initialStoredState.viewedFingerprintsByFileId,
					payload.files,
				);
				setBootstrap(payload);
				setReviewedByFileId(nextReviewedByFileId);
				setCollapsedFileIds((current) => {
					if (invalidatedReviewedFileIds.length === 0) {
						return current;
					}
					return {
						...current,
						...Object.fromEntries(invalidatedReviewedFileIds.map((fileId) => [fileId, false])),
					};
				});
				setBootstrapError(null);
				setExpired(false);
				setActiveFileId((current) => current ?? payload.files[0]?.id ?? null);
			})
			.catch((error) => {
				if (cancelled) {
					return;
				}
				setBootstrapError(error instanceof Error ? error.message : "Failed to load the viewer state.");
				setExpired(true);
			});
		return () => {
			cancelled = true;
		};
	}, [viewerToken]);

	useEffect(() => {
		setCollapsedCommentIds((current) => ensureCollapsedStateForOverallComments(current, comments));
	}, [comments]);

	useEffect(() => {
		if (!bootstrap) {
			return;
		}
		saveViewerState(viewerToken, {
			sidebarCollapsed,
			searchQuery,
			viewMode: viewModeOverride,
			wrapLines,
			reviewedByFileId,
			viewedFingerprintsByFileId: currentViewedFingerprintsByFileId,
			collapsedFileIds,
			collapsedCommentIds,
			comments,
		});
	}, [bootstrap, collapsedCommentIds, collapsedFileIds, comments, currentViewedFingerprintsByFileId, reviewedByFileId, searchQuery, sidebarCollapsed, viewModeOverride, viewerToken, wrapLines]);

	const registerCommentTextarea = useCallback((commentId: string, element: HTMLTextAreaElement | null) => {
		if (element) {
			commentTextareaRefs.current[commentId] = element;
			return;
		}
		delete commentTextareaRefs.current[commentId];
	}, []);

	const registerSearchInput = useCallback((element: HTMLInputElement | null) => {
		searchInputRef.current = element;
	}, []);

	useEffect(() => {
		if (!focusCommentId) {
			return;
		}
		const textarea = commentTextareaRefs.current[focusCommentId];
		if (!textarea) {
			return;
		}
		const frameId = requestAnimationFrame(() => {
			textarea.focus();
			const end = textarea.value.length;
			textarea.setSelectionRange(end, end);
			setFocusCommentId((current) => (current === focusCommentId ? null : current));
		});
		return () => cancelAnimationFrame(frameId);
	}, [comments, focusCommentId]);

	useEffect(() => {
		if (!focusSearchRequested || !sidebarVisible || sidebarCollapsedState) {
			return;
		}
		const searchInput = searchInputRef.current;
		if (!searchInput) {
			return;
		}
		const frameId = requestAnimationFrame(() => {
			searchInput.focus();
			searchInput.select();
			setFocusSearchRequested(false);
		});
		return () => cancelAnimationFrame(frameId);
	}, [focusSearchRequested, sidebarCollapsedState, sidebarVisible]);

	useEffect(() => {
		if (typeof window === "undefined") {
			return;
		}
		const mediaQuery = window.matchMedia("(max-width: 1000px)");
		const updateViewportState = () => {
			setIsNarrowViewport(mediaQuery.matches);
			if (!mediaQuery.matches) {
				setSidebarPopoverOpen(false);
			}
		};
		updateViewportState();
		mediaQuery.addEventListener("change", updateViewportState);
		return () => mediaQuery.removeEventListener("change", updateViewportState);
	}, []);

	const ensureFileLoaded = useCallback(
		async (fileId: string) => {
			if (loadedFiles[fileId] || loadingFileIds[fileId]) {
				return;
			}
			setLoadingFileIds((current) => ({ ...current, [fileId]: true }));
			try {
				const payload = await fetchJson<DiffFilePayload>(`/api/viewer/${viewerToken}/files/${fileId}`);
				setLoadedFiles((current) => ({ ...current, [fileId]: payload }));
				setLoadErrors((current) => {
					const next = { ...current };
					delete next[fileId];
					return next;
				});
			} catch (error) {
				setLoadErrors((current) => ({
					...current,
					[fileId]: error instanceof Error ? error.message : "Failed to load diff file.",
				}));
			} finally {
				setLoadingFileIds((current) => {
					const next = { ...current };
					delete next[fileId];
					return next;
				});
			}
		},
		[loadedFiles, loadingFileIds, viewerToken],
	);

	useEffect(() => {
		for (const file of files.slice(0, 8)) {
			void ensureFileLoaded(file.id);
		}
	}, [ensureFileLoaded, files]);

	useEffect(() => {
		if (files.length === 0) {
			return;
		}
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					const element = entry.target as HTMLElement;
					const fileId = element.dataset.fileId;
					if (!fileId) {
						continue;
					}
					if (entry.isIntersecting) {
						setActiveFileId(fileId);
						void ensureFileLoaded(fileId);
					}
				}
			},
			{ rootMargin: "400px 0px 400px 0px", threshold: 0.15 },
		);
		for (const file of files) {
			const element = fileSectionRefs.current[file.id];
			if (element) {
				observer.observe(element);
			}
		}
		return () => observer.disconnect();
	}, [ensureFileLoaded, files]);

	const sendComments = useCallback(
		async (items: DiffComment[]) => {
			if (items.length === 0 || expired) {
				return;
			}
			const pendingComments = items.filter((comment) => comment.sentAt === null && comment.text.trim().length > 0);
			if (pendingComments.length === 0) {
				return;
			}
			const response = await fetchJson<SendCommentsResponse>(`/api/viewer/${viewerToken}/send`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ comments: pendingComments }),
			});
			setComments((current) =>
				current.map((comment) =>
					pendingComments.some((candidate) => candidate.id === comment.id) ? { ...comment, sentAt: response.sentAt } : comment,
				),
			);
			setCollapsedCommentIds((current) => ({
				...current,
				...Object.fromEntries(pendingComments.map((comment) => [comment.id, true])),
			}));
		},
		[expired, viewerToken],
	);

	const toggleFileCollapsed = useCallback((fileId: string) => {
		setCollapsedFileIds((current) => ({
			...current,
			[fileId]: !current[fileId],
		}));
	}, []);

	const isFileCollapsed = useCallback((fileId: string) => Boolean(collapsedFileIds[fileId]), [collapsedFileIds]);

	const createFileComment = useCallback((file: DiffFileEntry) => {
		const existingDraft = findReusableDraftComment(comments, { kind: "file", fileId: file.id });
		if (existingDraft) {
			setCollapsedFileIds((current) => ({ ...current, [file.id]: false }));
			setCollapsedCommentIds((current) => ({ ...current, [existingDraft.id]: false }));
			setFocusCommentId(existingDraft.id);
			return;
		}
		const now = Date.now();
		const commentId = createCommentId("file");
		setComments((current) => [
			...current,
			{
				id: commentId,
				kind: "file",
				text: "",
				createdAt: now,
				updatedAt: now,
				sentAt: null,
				fileId: file.id,
				path: file.path,
				oldPath: file.oldPath,
				newPath: file.newPath,
			},
		]);
		setCollapsedFileIds((current) => ({ ...current, [file.id]: false }));
		setCollapsedCommentIds((current) => ({ ...current, [commentId]: false }));
		setFocusCommentId(commentId);
	}, [comments]);

	const createLineComment = useCallback((file: DiffFileEntry, change: ChangeData, side: "old" | "new") => {
		const lineNumber = resolveLineNumber(change, side);
		if (!lineNumber) {
			return;
		}
		const changeKey = getChangeKey(change);
		const existingDraft = findReusableDraftComment(comments, { kind: "line", fileId: file.id, changeKey });
		if (existingDraft) {
			setCollapsedFileIds((current) => ({ ...current, [file.id]: false }));
			setCollapsedCommentIds((current) => ({ ...current, [existingDraft.id]: false }));
			setFocusCommentId(existingDraft.id);
			return;
		}
		const now = Date.now();
		const commentId = createCommentId("line");
		setComments((current) => [
			...current,
			{
				id: commentId,
				kind: "line",
				text: "",
				createdAt: now,
				updatedAt: now,
				sentAt: null,
				fileId: file.id,
				path: file.path,
				oldPath: file.oldPath,
				newPath: file.newPath,
				lineNumber,
				side,
				changeKey,
				excerpt: extractExcerpt(change),
			} satisfies DiffLineComment,
		]);
		setCollapsedFileIds((current) => ({ ...current, [file.id]: false }));
		setCollapsedCommentIds((current) => ({ ...current, [commentId]: false }));
		setFocusCommentId(commentId);
	}, [comments]);

	const updateComment = useCallback((commentId: string, text: string) => {
		setComments((current) => current.map((comment) => (comment.id === commentId ? updateCommentText(comment, text) : comment)));
	}, []);

	const removeComment = useCallback((commentId: string) => {
		setComments((current) => normalizeOverallComments(removeCommentById(current, commentId)));
		setCollapsedCommentIds((current) => {
			const next = { ...current };
			delete next[commentId];
			return next;
		});
		setFocusCommentId((current) => (current === commentId ? null : current));
	}, []);

	const toggleCommentCollapsed = useCallback((commentId: string) => {
		setCollapsedCommentIds((current) => ({
			...current,
			[commentId]: !current[commentId],
		}));
	}, []);

	const isCommentCollapsed = useCallback((commentId: string) => Boolean(collapsedCommentIds[commentId]), [collapsedCommentIds]);

	const sendComment = useCallback(
		async (commentId: string) => {
			const comment = comments.find((candidate) => candidate.id === commentId);
			if (!comment) {
				return;
			}
			await sendComments([comment]);
		},
		[comments, sendComments],
	);

	const jumpToFile = useCallback(
		async (fileId: string) => {
			setActiveFileId(fileId);
			if (sidebarOverlayMode) {
				setSidebarPopoverOpen(false);
			}
			await ensureFileLoaded(fileId);
			fileSectionRefs.current[fileId]?.scrollIntoView({ behavior: "smooth", block: "start" });
		},
		[ensureFileLoaded, sidebarOverlayMode],
	);

	const refreshViewer = useCallback(() => {
		window.location.reload();
	}, []);

	const openSidebarSearch = useCallback(() => {
		if (sidebarOverlayMode) {
			setSidebarPopoverOpen((current) => {
				const next = !current;
				setFocusSearchRequested(next);
				return next;
			});
			return;
		}
		setSidebarCollapsed(false);
		setFocusSearchRequested(true);
	}, [sidebarOverlayMode]);

	const overallComments = comments.filter((comment): comment is DiffOverallComment => comment.kind === "overall");

	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if (isSendAllShortcut(event)) {
				event.preventDefault();
				void sendComments(unsentComments);
				return;
			}

			if (event.key === "Escape") {
				if (sidebarOverlayMode && sidebarPopoverOpen) {
					event.preventDefault();
					if (isEditableElement(document.activeElement)) {
						document.activeElement.blur();
					}
					setSidebarPopoverOpen(false);
					setFocusSearchRequested(false);
					return;
				}
				if (isEditableElement(document.activeElement)) {
					event.preventDefault();
					document.activeElement.blur();
					return;
				}
			}

			if (isEditableElement(event.target)) {
				return;
			}

			if (isFocusSearchShortcut(event)) {
				event.preventDefault();
				if (sidebarOverlayMode) {
					setSidebarPopoverOpen(true);
				} else {
					setSidebarCollapsed(false);
				}
				setFocusSearchRequested(true);
				return;
			}

			if (isRefreshShortcut(event)) {
				event.preventDefault();
				refreshViewer();
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [refreshViewer, sendComments, sidebarOverlayMode, sidebarPopoverOpen, unsentComments]);

	if (bootstrapError && !bootstrap) {
		return (
			<div className="app-shell app-shell--empty">
				<h1>Diff viewer unavailable</h1>
				<p>{bootstrapError}</p>
				{expired ? <p>Rerun the slash command to create a fresh viewer session.</p> : null}
			</div>
		);
	}

	return (
		<div className={`app-shell ${wrapLines ? "app-shell--wrap" : ""}`}>
			<Toolbar
				repoName={bootstrap?.repo.name ?? "diff-cmux"}
				targetLabel={bootstrap?.target.label ?? "Loading…"}
				viewMode={viewMode}
				wrapLines={wrapLines}
				unsentCount={unsentComments.length}
				expired={expired}
				onViewModeChange={setViewModeOverride}
				onWrapToggle={() => setWrapLines((current) => !current)}
				onToggleSidebarPopover={openSidebarSearch}
				onRefresh={refreshViewer}
				onSendAll={() => void sendComments(unsentComments)}
			/>
			<div className={getAppLayoutClassName(sidebarCollapsed, sidebarPopoverOpen)}>
				<button
					aria-label="Close file list"
					className={`app-layout__sidebar-backdrop ${sidebarOverlayMode && sidebarPopoverOpen ? "is-visible" : ""}`}
					onClick={() => setSidebarPopoverOpen(false)}
					type="button"
				/>
				<Sidebar
					repoName={bootstrap?.repo.name ?? "diff-cmux"}
					targetLabel={bootstrap?.target.label ?? "Loading…"}
					files={visibleSidebarFiles}
					activeFileId={activeFileId}
					searchQuery={searchQuery}
					collapsed={sidebarCollapsedState}
					overlayMode={sidebarOverlayMode}
					commentCounts={commentCounts}
					reviewedByFileId={reviewedByFileId}
					registerSearchInput={registerSearchInput}
					onDismissOverlay={() => setSidebarPopoverOpen(false)}
					onToggleCollapsed={() => setSidebarCollapsed((current) => !current)}
					onSearchChange={setSearchQuery}
					onFileClick={(fileId) => void jumpToFile(fileId)}
				/>
				<main className="file-stream">
					{expired ? <div className="banner banner--warning">This viewer session expired. You can still read local drafts, but sending is disabled until you rerun the command.</div> : null}
					{files.length === 0 ? <div className="empty-state">No diff files for this target. You can still leave overall comments.</div> : null}
					{searchQuery.trim() && visibleSidebarFiles.length === 0 ? <div className="empty-state">No files match the current search.</div> : null}
					<section
						className="overall-comments"
						ref={(element) => {
							overallCommentsRef.current = element;
						}}
					>
						<div className="overall-comments__header">
							<h2>Overall comments</h2>
						</div>
						{overallComments.length > 0 ? (
							<div className="overall-comments__list">
								{overallComments.map((comment) => {
									const canSend = !expired && comment.sentAt === null && comment.text.trim().length > 0;
									const collapsed = isCommentCollapsed(comment.id);
									const preview = comment.text.trim();
									const sendLabel = comment.sentAt ? "Sent" : "Send";
									if (collapsed) {
										return (
											<div className="comment-card comment-card--collapsed" key={comment.id}>
												<button className="comment-card__collapsed" onClick={() => toggleCommentCollapsed(comment.id)} type="button">
													<span className="comment-card__collapsed-chevron">{renderChevron(true)}</span>
													<span className="comment-card__preview-text">{preview}</span>
												</button>
											</div>
										);
									}
									return (
										<div className="comment-card" key={comment.id}>
											<div className="comment-card__header">
												<div className="comment-card__title-row">
													<button className="comment-card__toggle" onClick={() => toggleCommentCollapsed(comment.id)} type="button">
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
												placeholder="Write an overall comment"
												onChange={(event) => updateComment(comment.id, event.target.value)}
												onKeyDown={(event) => {
													if (!isCommentSendShortcut(event)) {
														return;
													}
													event.preventDefault();
													void sendComment(comment.id);
												}}
											/>
											<div className="comment-card__footer">
												<div className="comment-card__actions">
													<button className="comment-card__send button-with-shortcut" disabled={!canSend} onClick={() => void sendComment(comment.id)} type="button">
														{comment.sentAt ? (
															<span>{sendLabel}</span>
														) : (
															<>
																<span>{sendLabel}</span>
																<span className="shortcut-chip">{commentSendHint}</span>
															</>
														)}
													</button>
												</div>
											</div>
										</div>
									);
								})}
							</div>
						) : null}
					</section>
					{files.map((file) => (
						<section
							className="file-stream__section"
							data-file-id={file.id}
							key={file.id}
							ref={(element) => {
								fileSectionRefs.current[file.id] = element;
							}}
						>
							<FileDiff
								file={file}
								payload={loadedFiles[file.id] ?? null}
								loading={Boolean(loadingFileIds[file.id])}
								loadError={loadErrors[file.id] ?? null}
								viewMode={viewMode}
								wrapLines={wrapLines}
								reviewed={Boolean(reviewedByFileId[file.id])}
								collapsed={isFileCollapsed(file.id)}
								expired={expired}
								comments={comments.filter((comment) => comment.kind !== "overall" && comment.fileId === file.id)}
								onToggleCollapsed={() => toggleFileCollapsed(file.id)}
								onToggleReviewed={() => {
									setReviewedByFileId((current) => {
										const nextState = getNextReviewedToggleState(Boolean(current[file.id]));
										setCollapsedFileIds((collapsedCurrent) => ({
											...collapsedCurrent,
											[file.id]: nextState.collapsed,
										}));
										return {
											...current,
											[file.id]: nextState.reviewed,
										};
									});
								}}
								onAddFileComment={() => createFileComment(file)}
								onCreateLineComment={(change, side) => createLineComment(file, change, side)}
								onCommentTextChange={updateComment}
								onRemoveComment={removeComment}
								onToggleCommentCollapsed={toggleCommentCollapsed}
								isCommentCollapsed={isCommentCollapsed}
								registerCommentTextarea={registerCommentTextarea}
								onSendComment={(commentId) => void sendComment(commentId)}
							/>
						</section>
					))}
				</main>
			</div>
		</div>
	);
}
