import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getCurrentBranch, getDefaultBranch, getDefaultBranchInfo, getLocalBranches, getRecentCommits, hasWorkingTreeChanges } from "./git";
import type { DiffTarget } from "./types";

type DiffTargetPreset = "uncommitted" | "baseBranch" | "commit";

type ParsedDiffTargetArgs = DiffTarget | null;

const TARGET_PRESETS: Array<{ value: DiffTargetPreset; label: string; description: string }> = [
	{ value: "uncommitted", label: "Review uncommitted changes", description: "" },
	{ value: "baseBranch", label: "Compare against a branch", description: "" },
	{ value: "commit", label: "Review a commit", description: "" },
];

async function getSmartDefaultPreset(pi: ExtensionAPI, cwd: string): Promise<DiffTargetPreset> {
	if (await hasWorkingTreeChanges(pi, cwd)) {
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

function getPresetsForSelector(smartDefault: DiffTargetPreset) {
	const presets = smartDefault === "uncommitted" ? TARGET_PRESETS : TARGET_PRESETS.filter((preset) => preset.value !== "uncommitted");
	const smartDefaultIndex = presets.findIndex((preset) => preset.value === smartDefault);
	if (smartDefaultIndex <= 0) {
		return presets;
	}
	const selected = presets[smartDefaultIndex]!;
	return [selected, ...presets.slice(0, smartDefaultIndex), ...presets.slice(smartDefaultIndex + 1)];
}

export function parseDiffTargetArgs(args: string | undefined): ParsedDiffTargetArgs {
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
		default:
			return null;
	}
}

async function showBranchSelector(pi: ExtensionAPI, ctx: ExtensionContext): Promise<DiffTarget | null> {
	const branches = await getLocalBranches(pi, ctx.cwd);
	const [currentBranch, defaultBranch] = await Promise.all([getCurrentBranch(pi, ctx.cwd), getDefaultBranch(pi, ctx.cwd)]);
	const candidates = currentBranch ? branches.filter((branch) => branch !== currentBranch) : branches;
	if (candidates.length === 0) {
		ctx.ui.notify(currentBranch ? `No other branches found (current branch: ${currentBranch})` : "No branches found", "error");
		return null;
	}

	const sorted = [...candidates].sort((left, right) => {
		if (left === defaultBranch) {
			return -1;
		}
		if (right === defaultBranch) {
			return 1;
		}
		return left.localeCompare(right);
	});
	const labels = sorted.map((branch) => (branch === defaultBranch ? `${branch} (default)` : branch));
	const selection = await ctx.ui.select("Select a branch to compare against", labels);
	if (selection === undefined) {
		return null;
	}
	const index = labels.indexOf(selection);
	if (index < 0) {
		return null;
	}
	return {
		type: "baseBranch",
		branch: sorted[index]!,
	};
}

async function showCommitSelector(pi: ExtensionAPI, ctx: ExtensionContext): Promise<DiffTarget | null> {
	const commits = await getRecentCommits(pi, 20, ctx.cwd);
	if (commits.length === 0) {
		ctx.ui.notify("No commits found", "error");
		return null;
	}

	const labels = commits.map((commit) => `${commit.sha.slice(0, 7)} ${commit.title}`.trim());
	const selection = await ctx.ui.select("Select a commit to review", labels);
	if (selection === undefined) {
		return null;
	}
	const index = labels.indexOf(selection);
	if (index < 0) {
		return null;
	}
	return {
		type: "commit",
		sha: commits[index]!.sha,
		title: commits[index]!.title,
	};
}

async function showTargetSelector(pi: ExtensionAPI, ctx: ExtensionContext): Promise<DiffTarget | null> {
	const smartDefault = await getSmartDefaultPreset(pi, ctx.cwd);
	const orderedPresets = getPresetsForSelector(smartDefault);
	while (true) {
		const labels = orderedPresets.map((preset) => `${preset.label}${preset.description ? ` ${preset.description}` : ""}`);
		const selection = await ctx.ui.select("Select a diff target", labels);
		if (selection === undefined) {
			return null;
		}
		const index = labels.indexOf(selection);
		const preset = orderedPresets[index];
		if (!preset) {
			return null;
		}
		switch (preset.value) {
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
		}
	}
}

export async function resolveDiffTargetFromArgs(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	args: string,
): Promise<DiffTarget | null> {
	const trimmedArgs = args.trim();
	const parsed = parseDiffTargetArgs(trimmedArgs);
	if (parsed) {
		if (parsed.type === "uncommitted" && !(await hasWorkingTreeChanges(pi, ctx.cwd))) {
			ctx.ui.notify("No uncommitted changes found", "error");
			return null;
		}
		return parsed;
	}

	if (trimmedArgs.length > 0) {
		ctx.ui.notify("Invalid diff target. Use uncommitted, branch <name>, or commit <sha>.", "error");
		return null;
	}

	return await showTargetSelector(pi, ctx);
}
