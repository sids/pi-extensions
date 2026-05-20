import type { DiffComment, DiffViewMode } from "../types";

export type StoredReviewState = {
	sidebarCollapsed: boolean;
	searchQuery: string;
	viewMode: DiffViewMode | null;
	wrapLines: boolean;
	reviewedByFileId: Record<string, boolean>;
	viewedFingerprintsByFileId: Record<string, string>;
	collapsedFileIds: Record<string, boolean>;
	collapsedCommentIds: Record<string, boolean>;
	comments: DiffComment[];
};

const STORAGE_PREFIX = "pi-diff-review:";

export function createDefaultStoredReviewState(): StoredReviewState {
	return {
		sidebarCollapsed: false,
		searchQuery: "",
		viewMode: null,
		wrapLines: true,
		reviewedByFileId: {},
		viewedFingerprintsByFileId: {},
		collapsedFileIds: {},
		collapsedCommentIds: {},
		comments: [],
	};
}

export function loadReviewState(reviewToken: string): StoredReviewState {
	if (typeof localStorage === "undefined") {
		return createDefaultStoredReviewState();
	}
	try {
		const raw = localStorage.getItem(`${STORAGE_PREFIX}${reviewToken}`);
		if (!raw) {
			return createDefaultStoredReviewState();
		}
		const parsed = JSON.parse(raw) as Partial<StoredReviewState>;
		return {
			...createDefaultStoredReviewState(),
			...parsed,
			reviewedByFileId: parsed.reviewedByFileId ?? {},
			viewedFingerprintsByFileId: parsed.viewedFingerprintsByFileId ?? {},
			collapsedFileIds: parsed.collapsedFileIds ?? {},
			collapsedCommentIds: parsed.collapsedCommentIds ?? {},
			comments: Array.isArray(parsed.comments) ? parsed.comments : [],
		};
	} catch {
		return createDefaultStoredReviewState();
	}
}

export function saveReviewState(reviewToken: string, state: StoredReviewState): void {
	if (typeof localStorage === "undefined") {
		return;
	}
	try {
		localStorage.setItem(`${STORAGE_PREFIX}${reviewToken}`, JSON.stringify(state));
	} catch {
		// Draft persistence should not break the review page when storage is unavailable.
	}
}
