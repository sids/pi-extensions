import type { DiffFileEntry } from "../types";

function getFileFingerprint(file: DiffFileEntry): string {
	return file.fingerprint ?? [file.status, file.oldPath ?? "", file.newPath ?? "", file.path].join("\u0000");
}

export function getNextReviewedToggleState(reviewed: boolean) {
	const nextReviewed = !reviewed;
	return {
		reviewed: nextReviewed,
		collapsed: nextReviewed,
	};
}

export function buildViewedFingerprintsByFileId(files: DiffFileEntry[]): Record<string, string> {
	return Object.fromEntries(files.map((file) => [file.id, getFileFingerprint(file)]));
}

export function reconcileReviewedByFileId(
	reviewedByFileId: Record<string, boolean>,
	viewedFingerprintsByFileId: Record<string, string>,
	files: DiffFileEntry[],
): Record<string, boolean> {
	const nextReviewedByFileId: Record<string, boolean> = {};
	for (const file of files) {
		if (!reviewedByFileId[file.id]) {
			continue;
		}
		if (viewedFingerprintsByFileId[file.id] !== getFileFingerprint(file)) {
			continue;
		}
		nextReviewedByFileId[file.id] = true;
	}
	return nextReviewedByFileId;
}

export function getInvalidatedReviewedFileIds(
	reviewedByFileId: Record<string, boolean>,
	viewedFingerprintsByFileId: Record<string, string>,
	files: DiffFileEntry[],
): string[] {
	return files
		.filter((file) => reviewedByFileId[file.id] && viewedFingerprintsByFileId[file.id] !== getFileFingerprint(file))
		.map((file) => file.id);
}
