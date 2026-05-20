import type { FileDiffMetadata } from "@pierre/diffs";

export type DiffTarget =
	| { type: "uncommitted" }
	| { type: "baseBranch"; branch: string }
	| { type: "commit"; sha: string; title?: string };

export type DiffViewMode = "unified" | "split";

export type DiffFileStatus = "modified" | "added" | "deleted" | "renamed";

export type RepoMetadata = {
	root: string;
	name: string;
	cwd: string;
};

export type ResolvedDiffTarget = DiffTarget & {
	label: string;
	subtitle: string;
	baseRev: string | null;
	headRev: string | null;
	hasHead: boolean;
};

export type DiffFileEntry = {
	id: string;
	path: string;
	oldPath: string | null;
	newPath: string | null;
	status: DiffFileStatus;
	anchorId: string;
	isBinary: boolean;
	fingerprint?: string;
};

export type DiffFilePayload = {
	file: DiffFileEntry;
	diffText: string | null;
	parsedDiff?: FileDiffMetadata;
	message?: string;
};

export type ReviewBootstrapPayload = {
	reviewToken: string;
	repo: RepoMetadata;
	target: ResolvedDiffTarget;
	files: DiffFileEntry[];
	defaultViewMode: DiffViewMode;
};

export type LineCommentSide = "old" | "new";

export type DiffCommentBase = {
	id: string;
	text: string;
	createdAt: number;
	updatedAt: number;
	sentAt: number | null;
};

export type DiffLineComment = DiffCommentBase & {
	kind: "line";
	fileId: string;
	path: string;
	oldPath: string | null;
	newPath: string | null;
	lineNumber: number;
	side: LineCommentSide;
	changeKey: string;
	excerpt?: string;
};

export type DiffFileComment = DiffCommentBase & {
	kind: "file";
	fileId: string;
	path: string;
	oldPath: string | null;
	newPath: string | null;
};

export type DiffOverallComment = DiffCommentBase & {
	kind: "overall";
};

export type DiffComment = DiffLineComment | DiffFileComment | DiffOverallComment;

export type SendCommentsResponse = {
	sentAt: number;
	formattedText: string;
};

export type DiffReviewData = {
	repo: RepoMetadata;
	target: ResolvedDiffTarget;
	files: DiffFileEntry[];
	filePayloads: Map<string, DiffFilePayload>;
};

export type ReviewSession = {
	token: string;
	bootstrap: ReviewBootstrapPayload;
	refreshBootstrap?: () => Promise<ReviewBootstrapPayload>;
	loadFile: (fileId: string) => Promise<DiffFilePayload | null>;
	sendComments: (comments: DiffComment[]) => Promise<SendCommentsResponse>;
};
