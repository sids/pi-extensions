import type { DiffComment, DiffViewMode } from "../types";

export type StoredViewerState = {
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

const STORAGE_PREFIX = "pi-diff-cmux:";

export function createDefaultStoredViewerState(): StoredViewerState {
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

export function loadViewerState(viewerToken: string): StoredViewerState {
	if (typeof localStorage === "undefined") {
		return createDefaultStoredViewerState();
	}
	try {
		const raw = localStorage.getItem(`${STORAGE_PREFIX}${viewerToken}`);
		if (!raw) {
			return createDefaultStoredViewerState();
		}
		const parsed = JSON.parse(raw) as Partial<StoredViewerState>;
		return {
			...createDefaultStoredViewerState(),
			...parsed,
			reviewedByFileId: parsed.reviewedByFileId ?? {},
			viewedFingerprintsByFileId: parsed.viewedFingerprintsByFileId ?? {},
			collapsedFileIds: parsed.collapsedFileIds ?? {},
			collapsedCommentIds: parsed.collapsedCommentIds ?? {},
			comments: Array.isArray(parsed.comments) ? parsed.comments : [],
		};
	} catch {
		return createDefaultStoredViewerState();
	}
}

export function saveViewerState(viewerToken: string, state: StoredViewerState): void {
	if (typeof localStorage === "undefined") {
		return;
	}
	localStorage.setItem(`${STORAGE_PREFIX}${viewerToken}`, JSON.stringify(state));
}
