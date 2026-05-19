import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { findReusableDraftComment, removeCommentById, updateCommentText } from "../comments";
import type { DiffComment, DiffFileEntry, DiffFilePayload, DiffLineComment, DiffOverallComment, DiffViewMode, SendCommentsResponse, ReviewBootstrapPayload } from "../types";
import { getAppLayoutClassName } from "./layout";
import { ensureCollapsedStateForOverallComments } from "./overall-comments";
import { loadReviewState, saveReviewState } from "./storage";
import { getCommentSendHint, isCommentSendShortcut, isFocusSearchShortcut, isRefreshShortcut, isSendAllShortcut } from "./shortcuts";
import { buildViewedFingerprintsByFileId, getInvalidatedReviewedFileIds, getNextReviewedToggleState, reconcileReviewedByFileId } from "./reviewed";
import { FileDiff } from "./components/file-diff";
import { Sidebar } from "./components/sidebar";
import { Toolbar } from "./components/toolbar";

type AppProps = {
	reviewToken: string;
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

export type DiffLineTarget = {
	lineNumber: number;
	side: "old" | "new";
	changeKey: string;
	excerpt?: string;
};

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

export function App({ reviewToken }: AppProps) {
	const initialStoredState = useMemo(() => loadReviewState(reviewToken), [reviewToken]);
	const [bootstrap, setBootstrap] = useState<ReviewBootstrapPayload | null>(null);
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
	const loadedFilesRef = useRef<Record<string, DiffFilePayload>>({});
	const loadingFileIdsRef = useRef<Record<string, boolean>>({});
	const [activeFileId, setActiveFileId] = useState<string | null>(null);
	const [focusCommentId, setFocusCommentId] = useState<string | null>(null);
	const fileStreamRef = useRef<HTMLElement | null>(null);
	const fileSectionRefs = useRef<Record<string, HTMLElement | null>>({});
	const commentTextareaRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
	const activeFileUpdateFrameRef = useRef<number | null>(null);
	const commentSendHint = useMemo(() => getCommentSendHint(), []);
	const [searchRequestCount, setSearchRequestCount] = useState(0);
	const [sidebarPopoverOpen, setSidebarPopoverOpen] = useState(false);
	const [isNarrowViewport, setIsNarrowViewport] = useState(() =>
		typeof window !== "undefined" ? window.matchMedia("(max-width: 1000px)").matches : false,
	);

	const viewMode = viewModeOverride ?? bootstrap?.defaultViewMode ?? "unified";
	const files = bootstrap?.files ?? [];
	const sidebarOverlayMode = isNarrowViewport;
	const sidebarCollapsedState = sidebarOverlayMode ? false : sidebarCollapsed;
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
		void fetchJson<ReviewBootstrapPayload>(`/api/review/${reviewToken}`)
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
				setBootstrapError(error instanceof Error ? error.message : "Failed to load the review state.");
				setExpired(true);
			});
		return () => {
			cancelled = true;
		};
	}, [reviewToken]);

	useEffect(() => {
		setCollapsedCommentIds((current) => ensureCollapsedStateForOverallComments(current, comments));
	}, [comments]);

	useEffect(() => {
		if (!bootstrap) {
			return;
		}
		saveReviewState(reviewToken, {
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
	}, [bootstrap, collapsedCommentIds, collapsedFileIds, comments, currentViewedFingerprintsByFileId, reviewedByFileId, searchQuery, sidebarCollapsed, viewModeOverride, reviewToken, wrapLines]);

	useEffect(() => {
		loadedFilesRef.current = loadedFiles;
	}, [loadedFiles]);

	useEffect(() => {
		loadingFileIdsRef.current = loadingFileIds;
	}, [loadingFileIds]);

	const registerCommentTextarea = useCallback((commentId: string, element: HTMLTextAreaElement | null) => {
		if (element) {
			commentTextareaRefs.current[commentId] = element;
			return;
		}
		delete commentTextareaRefs.current[commentId];
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
			if (loadedFilesRef.current[fileId] || loadingFileIdsRef.current[fileId]) {
				return;
			}
			loadingFileIdsRef.current = { ...loadingFileIdsRef.current, [fileId]: true };
			setLoadingFileIds((current) => ({ ...current, [fileId]: true }));
			try {
				const payload = await fetchJson<DiffFilePayload>(`/api/review/${reviewToken}/files/${fileId}`);
				loadedFilesRef.current = { ...loadedFilesRef.current, [fileId]: payload };
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
				const nextLoadingFileIds = { ...loadingFileIdsRef.current };
				delete nextLoadingFileIds[fileId];
				loadingFileIdsRef.current = nextLoadingFileIds;
				setLoadingFileIds((current) => {
					const next = { ...current };
					delete next[fileId];
					return next;
				});
			}
		},
		[reviewToken],
	);

	useEffect(() => {
		for (const file of files.slice(0, 8)) {
			void ensureFileLoaded(file.id);
		}
	}, [ensureFileLoaded, files]);

	const updateActiveFileFromScroll = useCallback(() => {
		const container = fileStreamRef.current;
		if (!container || files.length === 0) {
			return;
		}

		const containerRect = container.getBoundingClientRect();
		const visibleFiles = files
			.map((file) => {
				const element = fileSectionRefs.current[file.id];
				if (!element) {
					return null;
				}
				const rect = element.getBoundingClientRect();
				return {
					file,
					top: rect.top - containerRect.top,
					bottom: rect.bottom - containerRect.top,
				};
			})
			.filter((entry): entry is { file: DiffFileEntry; top: number; bottom: number } => Boolean(entry))
			.filter((entry) => entry.bottom > 0 && entry.top < containerRect.height);

		if (visibleFiles.length === 0) {
			return;
		}

		const anchorOffset = 72;
		const anchoredFile = [...visibleFiles].reverse().find((entry) => entry.top <= anchorOffset);
		setActiveFileId((current) => {
			const nextFileId = (anchoredFile ?? visibleFiles[0]!).file.id;
			return current === nextFileId ? current : nextFileId;
		});
	}, [files]);

	const scheduleActiveFileUpdate = useCallback(() => {
		if (activeFileUpdateFrameRef.current !== null) {
			return;
		}
		activeFileUpdateFrameRef.current = requestAnimationFrame(() => {
			activeFileUpdateFrameRef.current = null;
			updateActiveFileFromScroll();
		});
	}, [updateActiveFileFromScroll]);

	useEffect(() => {
		const container = fileStreamRef.current;
		if (!container) {
			return;
		}
		container.addEventListener("scroll", scheduleActiveFileUpdate, { passive: true });
		updateActiveFileFromScroll();
		return () => {
			container.removeEventListener("scroll", scheduleActiveFileUpdate);
			if (activeFileUpdateFrameRef.current !== null) {
				cancelAnimationFrame(activeFileUpdateFrameRef.current);
				activeFileUpdateFrameRef.current = null;
			}
		};
	}, [scheduleActiveFileUpdate, updateActiveFileFromScroll]);

	useEffect(() => {
		if (files.length === 0) {
			return;
		}
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					const element = entry.target as HTMLElement;
					const fileId = element.dataset.fileId;
					if (fileId && entry.isIntersecting) {
						void ensureFileLoaded(fileId);
					}
				}
			},
			{ root: fileStreamRef.current, rootMargin: "600px 0px 600px 0px", threshold: 0.01 },
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
			const response = await fetchJson<SendCommentsResponse>(`/api/review/${reviewToken}/send`, {
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
		[expired, reviewToken],
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

	const createLineComment = useCallback((file: DiffFileEntry, target: DiffLineTarget) => {
		const existingDraft = findReusableDraftComment(comments, { kind: "line", fileId: file.id, changeKey: target.changeKey });
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
				lineNumber: target.lineNumber,
				side: target.side,
				changeKey: target.changeKey,
				excerpt: target.excerpt,
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

	const scrollToFile = useCallback((fileId: string, behavior: ScrollBehavior = "smooth") => {
		const element = fileSectionRefs.current[fileId];
		const container = element?.closest(".file-stream");
		if (!(element instanceof HTMLElement) || !(container instanceof HTMLElement)) {
			return;
		}
		const targetTop = element.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop - 12;
		container.scrollTo({ top: Math.max(targetTop, 0), behavior });
	}, []);

	const jumpToFile = useCallback(
		async (fileId: string) => {
			setActiveFileId(fileId);
			if (sidebarOverlayMode) {
				setSidebarPopoverOpen(false);
			}
			await ensureFileLoaded(fileId);
			requestAnimationFrame(() => {
				requestAnimationFrame(() => scrollToFile(fileId, "auto"));
			});
			window.setTimeout(() => scrollToFile(fileId, "auto"), 250);
		},
		[ensureFileLoaded, scrollToFile, sidebarOverlayMode],
	);

	const refreshReview = useCallback(() => {
		window.location.reload();
	}, []);

	const openSidebarSearch = useCallback(() => {
		if (sidebarOverlayMode) {
			setSidebarPopoverOpen(true);
		} else {
			setSidebarCollapsed(false);
		}
		setSearchRequestCount((current) => current + 1);
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
				openSidebarSearch();
				return;
			}

			if (isRefreshShortcut(event)) {
				event.preventDefault();
				refreshReview();
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [refreshReview, openSidebarSearch, sendComments, sidebarOverlayMode, sidebarPopoverOpen, unsentComments]);

	if (bootstrapError && !bootstrap) {
		return (
			<div className="app-shell app-shell--empty">
				<h1>Diff review unavailable</h1>
				<p>{bootstrapError}</p>
				{expired ? <p>Rerun the slash command to create a fresh review session.</p> : null}
			</div>
		);
	}

	return (
		<div className={`app-shell ${wrapLines ? "app-shell--wrap" : ""}`}>
			<Toolbar
				repoName={bootstrap?.repo.name ?? "diff-review"}
				targetLabel={bootstrap?.target.label ?? "Loading…"}
				viewMode={viewMode}
				wrapLines={wrapLines}
				unsentCount={unsentComments.length}
				expired={expired}
				onViewModeChange={setViewModeOverride}
				onWrapToggle={() => setWrapLines((current) => !current)}
				onToggleSidebarPopover={openSidebarSearch}
				onRefresh={refreshReview}
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
					repoName={bootstrap?.repo.name ?? "diff-review"}
					targetLabel={bootstrap?.target.label ?? "Loading…"}
					files={files}
					activeFileId={activeFileId}
					searchQuery={searchQuery}
					collapsed={sidebarCollapsedState}
					overlayMode={sidebarOverlayMode}
					commentCounts={commentCounts}
					reviewedByFileId={reviewedByFileId}
					searchRequestCount={searchRequestCount}
					onDismissOverlay={() => setSidebarPopoverOpen(false)}
					onToggleCollapsed={() => setSidebarCollapsed((current) => !current)}
					onSearchChange={setSearchQuery}
					onFileClick={(fileId) => void jumpToFile(fileId)}
				/>
				<main
					className="file-stream"
					ref={(element) => {
						fileStreamRef.current = element;
					}}
				>
					{expired ? <div className="banner banner--warning">This review session expired. You can still read local drafts, but sending is disabled until you rerun the command.</div> : null}
					{files.length === 0 ? <div className="empty-state">No diff files for this target. You can still leave overall comments.</div> : null}

					<section className="overall-comments">
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
								onCreateLineComment={(target) => createLineComment(file, target)}
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
