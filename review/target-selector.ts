import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	checkoutPr,
	getCurrentBranch,
	getDefaultBranch,
	getDefaultBranchInfo,
	getLocalBranches,
	getPrInfo,
	getRecentCommits,
	hasPendingChanges,
	hasUncommittedChanges,
} from "./git";
import type { ReviewTarget } from "./types";
import { parsePrLocator, parseReviewPaths } from "./utils";

type ReviewPreset = "uncommitted" | "commit" | "baseBranch" | "pullRequest" | "folder" | "custom";

const REVIEW_PRESETS: Array<{ value: ReviewPreset; label: string; description: string }> = [
	{ value: "uncommitted", label: "Review uncommitted changes", description: "" },
	{ value: "commit", label: "Review a commit", description: "" },
	{ value: "baseBranch", label: "Review against a base branch", description: "(local)" },
	{ value: "pullRequest", label: "Review a pull request", description: "(GitHub PR)" },
	{ value: "folder", label: "Review a folder (or more)", description: "(snapshot, not diff)" },
	{ value: "custom", label: "Custom review instructions", description: "" },
];

export type ParsedReviewArgs = ReviewTarget | { type: "pr"; ref: string } | null;

type SmartDefaultReviewPreset = "uncommitted" | "baseBranch" | "commit";

async function getSmartDefaultReviewPreset(pi: ExtensionAPI, cwd: string): Promise<SmartDefaultReviewPreset> {
	if (await hasUncommittedChanges(pi, cwd)) {
		return "uncommitted";
	}

	const [currentBranch, localBranches, defaultBranchInfo] = await Promise.all([
		getCurrentBranch(pi, cwd),
		getLocalBranches(pi, cwd),
		getDefaultBranchInfo(pi, cwd),
	]);
	if (!currentBranch) {
		return "commit";
	}

	const hasAlternateLocalBranch = localBranches.some((branch) => branch !== currentBranch);
	if (!hasAlternateLocalBranch) {
		return "commit";
	}

	if (!defaultBranchInfo.isReliable) {
		return "commit";
	}

	if (currentBranch !== defaultBranchInfo.branch) {
		return "baseBranch";
	}

	return "commit";
}

function getReviewPresetsForSelector(smartDefault: SmartDefaultReviewPreset) {
	const presets =
		smartDefault === "uncommitted"
			? REVIEW_PRESETS
			: REVIEW_PRESETS.filter((preset) => preset.value !== "uncommitted");

	const smartDefaultIndex = presets.findIndex((preset) => preset.value === smartDefault);
	if (smartDefaultIndex <= 0) {
		return presets;
	}

	const smartDefaultPreset = presets[smartDefaultIndex];
	return [
		smartDefaultPreset,
		...presets.slice(0, smartDefaultIndex),
		...presets.slice(smartDefaultIndex + 1),
	];
}

export function parseReviewArgs(args: string | undefined): ParsedReviewArgs {
	if (!args?.trim()) {
		return null;
	}

	const parts = args.trim().split(/\s+/);
	const subcommand = (parts[0] ?? "").toLowerCase();

	switch (subcommand) {
		case "uncommitted":
			return { type: "uncommitted" };
		case "branch": {
			const branch = parts[1];
			if (!branch) {
				return null;
			}
			return { type: "baseBranch", branch };
		}
		case "commit": {
			const sha = parts[1];
			if (!sha) {
				return null;
			}
			const title = parts.slice(2).join(" ") || undefined;
			return { type: "commit", sha, title };
		}
		case "folder": {
			const paths = parseReviewPaths(parts.slice(1).join(" "));
			if (paths.length === 0) {
				return null;
			}
			return { type: "folder", paths };
		}
		case "custom": {
			const instructions = parts.slice(1).join(" ").trim();
			return { type: "custom", instructions };
		}
		case "pr": {
			const ref = parts[1]?.trim();
			if (!ref) {
				return null;
			}
			return { type: "pr", ref };
		}
		default:
			return null;
	}
}

async function resolvePullRequestTarget(pi: ExtensionAPI, ctx: ExtensionContext, ref: string): Promise<ReviewTarget | null> {
	if (await hasPendingChanges(pi, ctx.cwd)) {
		ctx.ui.notify("Cannot checkout PR: you have uncommitted changes. Please commit or stash them first.", "error");
		return null;
	}

	const parsedRef = parsePrLocator(ref);
	if (!parsedRef) {
		ctx.ui.notify("Invalid PR reference. Enter a number or GitHub PR URL.", "error");
		return null;
	}

	ctx.ui.notify(`Fetching PR #${parsedRef.prNumber} info...`, "info");
	const prInfo = await getPrInfo(pi, parsedRef.ghRef, ctx.cwd);
	if (!prInfo) {
		ctx.ui.notify(`Could not find PR #${parsedRef.prNumber}. Make sure gh is authenticated and the PR exists.`, "error");
		return null;
	}

	return {
		type: "pullRequest",
		prNumber: parsedRef.prNumber,
		baseBranch: prInfo.baseBranch,
		title: prInfo.title,
		ghRef: parsedRef.ghRef,
	};
}

export async function checkoutPullRequestTarget(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	target: ReviewTarget,
): Promise<boolean> {
	if (target.type !== "pullRequest") {
		return true;
	}

	if (await hasPendingChanges(pi, ctx.cwd)) {
		ctx.ui.notify("Cannot checkout PR: you have uncommitted changes. Please commit or stash them first.", "error");
		return false;
	}

	ctx.ui.notify(`Checking out PR #${target.prNumber}...`, "info");
	const checkout = await checkoutPr(pi, target.ghRef ?? target.prNumber, ctx.cwd);
	if (!checkout.success) {
		ctx.ui.notify(`Failed to checkout PR: ${checkout.error ?? "unknown error"}`, "error");
		return false;
	}

	ctx.ui.notify(`Checked out PR #${target.prNumber}`, "info");
	return true;
}

async function showBranchSelector(pi: ExtensionAPI, ctx: ExtensionContext): Promise<ReviewTarget | null> {
	const branches = await getLocalBranches(pi, ctx.cwd);
	const [currentBranch, defaultBranch] = await Promise.all([
		getCurrentBranch(pi, ctx.cwd),
		getDefaultBranch(pi, ctx.cwd),
	]);
	const candidates = currentBranch ? branches.filter((branch) => branch !== currentBranch) : branches;
	if (candidates.length === 0) {
		ctx.ui.notify(
			currentBranch ? `No other branches found (current branch: ${currentBranch})` : "No branches found",
			"error",
		);
		return null;
	}

	const sorted = candidates.sort((a, b) => {
		if (a === defaultBranch) {
			return -1;
		}
		if (b === defaultBranch) {
			return 1;
		}
		return a.localeCompare(b);
	});

	const labels = sorted.map((branch) => (branch === defaultBranch ? `${branch} (default)` : branch));
	const selection = await ctx.ui.select("Select base branch", labels);
	if (selection === undefined) {
		return null;
	}

	const index = labels.indexOf(selection);
	if (index < 0) {
		return null;
	}

	return {
		type: "baseBranch",
		branch: sorted[index],
	};
}

async function showCommitSelector(pi: ExtensionAPI, ctx: ExtensionContext): Promise<ReviewTarget | null> {
	const commits = await getRecentCommits(pi, 20, ctx.cwd);
	if (commits.length === 0) {
		ctx.ui.notify("No commits found", "error");
		return null;
	}

	const labels = commits.map((commit) => `${commit.sha.slice(0, 7)} ${commit.title}`.trim());
	const selection = await ctx.ui.select("Select commit to review", labels);
	if (selection === undefined) {
		return null;
	}

	const index = labels.indexOf(selection);
	if (index < 0) {
		return null;
	}

	return {
		type: "commit",
		sha: commits[index].sha,
		title: commits[index].title,
	};
}

async function showFolderInput(ctx: ExtensionContext): Promise<ReviewTarget | null> {
	const result = await ctx.ui.editor("Enter folders/files to review (space-separated or one per line):", ".");
	if (!result?.trim()) {
		return null;
	}
	const paths = parseReviewPaths(result);
	if (paths.length === 0) {
		return null;
	}
	return {
		type: "folder",
		paths,
	};
}

async function showPrInput(pi: ExtensionAPI, ctx: ExtensionContext): Promise<ReviewTarget | null> {
	const prRef = await ctx.ui.editor(
		"Enter PR number or URL (e.g. 123 or https://github.com/owner/repo/pull/123):",
		"",
	);
	if (!prRef?.trim()) {
		return null;
	}
	return resolvePullRequestTarget(pi, ctx, prRef.trim());
}

async function showReviewSelector(pi: ExtensionAPI, ctx: ExtensionContext): Promise<ReviewTarget | null> {
	const smartDefault = await getSmartDefaultReviewPreset(pi, ctx.cwd);
	const ordered = getReviewPresetsForSelector(smartDefault);

	while (true) {
		const labels = ordered.map((preset) => `${preset.label}${preset.description ? ` ${preset.description}` : ""}`);
		const selection = await ctx.ui.select("Select a review preset", labels);
		if (selection === undefined) {
			return null;
		}

		const selectedIndex = labels.indexOf(selection);
		const selected = ordered[selectedIndex];
		if (!selected) {
			return null;
		}

		switch (selected.value) {
			case "uncommitted":
				return { type: "uncommitted" };
			case "baseBranch": {
				const target = await showBranchSelector(pi, ctx);
				if (target) {
					return target;
				}
				break;
			}
			case "commit": {
				const target = await showCommitSelector(pi, ctx);
				if (target) {
					return target;
				}
				break;
			}
			case "custom":
				return { type: "custom", instructions: "" };
			case "folder": {
				const target = await showFolderInput(ctx);
				if (target) {
					return target;
				}
				break;
			}
			case "pullRequest": {
				const target = await showPrInput(pi, ctx);
				if (target) {
					return target;
				}
				break;
			}
		}
	}
}

export async function resolveReviewTarget(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	args: string,
): Promise<ReviewTarget | null> {
	const trimmedArgs = args.trim();
	const parsed = parseReviewArgs(trimmedArgs);
	if (parsed) {
		if (parsed.type === "pr") {
			return resolvePullRequestTarget(pi, ctx, parsed.ref);
		}
		if (parsed.type === "uncommitted" && !(await hasUncommittedChanges(pi, ctx.cwd))) {
			ctx.ui.notify("No uncommitted changes found", "error");
			return null;
		}
		return parsed;
	}

	if (trimmedArgs.length > 0) {
		ctx.ui.notify(
			"Invalid /review args. Use uncommitted, branch <name>, commit <sha>, folder <paths>, custom [instructions], or pr <number-or-url>.",
			"error",
		);
		return null;
	}

	return showReviewSelector(pi, ctx);
}
