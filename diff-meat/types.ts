export type CodeReviewResult = {
	approved: boolean;
	feedback?: string;
	exit?: boolean;
};

export type PreparedDiff = {
	rawPatch: string;
	gitRef: string;
	diffType: "uncommitted" | "merge-base" | `commit:${string}`;
	repoRoot: string;
};

export type ReadingDiff = {
	rawPatch: string;
	summary: string;
	keptSections: number;
	totalSections: number;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	fromCache: boolean;
};
