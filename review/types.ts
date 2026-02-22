export type ReviewPriority = "P0" | "P1" | "P2" | "P3";

export type ReviewReference = {
	filePath: string;
	startLine: number;
	endLine?: number;
};

export type ReviewTarget =
	| { type: "uncommitted" }
	| { type: "baseBranch"; branch: string }
	| { type: "commit"; sha: string; title?: string }
	| { type: "custom"; instructions: string }
	| { type: "pullRequest"; prNumber: number; baseBranch: string; title: string; ghRef?: string }
	| { type: "folder"; paths: string[] };

export type ReviewModeState = {
	version: number;
	active: boolean;
	originLeafId?: string;
	lastReviewLeafId?: string;
	runId?: string;
	targetHint?: string;
	reviewInstructionsPrompt?: string;
	originModelProvider?: string;
	originModelId?: string;
	originThinkingLevel?: string;
};

export type PersistedReviewComment = {
	version: number;
	id: string;
	runId: string;
	priority: ReviewPriority;
	comment: string;
	references: ReviewReference[];
	createdAt: number;
};

export type ReviewComment = PersistedReviewComment;

export type TriagedReviewComment = {
	id: string;
	keep: boolean;
	priority: ReviewPriority;
	comment: string;
	references: ReviewReference[];
	note?: string;
	originalPriority: ReviewPriority;
};

export type ReviewTriageResult = {
	comments: TriagedReviewComment[];
	keptCount: number;
	discardedCount: number;
};
