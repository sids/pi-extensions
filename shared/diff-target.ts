import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type DiffTarget =
	| { type: "uncommitted" }
	| { type: "baseBranch"; branch: string }
	| { type: "commit"; sha: string; title?: string };

export type DefaultBranchInfo = {
	branch: string;
	isReliable: boolean;
};

type DiffTargetPreset = "uncommitted" | "baseBranch" | "commit";

const TARGET_PRESETS: Array<{ value: DiffTargetPreset; label: string }> = [
	{ value: "uncommitted", label: "Review uncommitted changes" },
	{ value: "baseBranch", label: "Compare against a branch" },
	{ value: "commit", label: "Review a commit" },
];

async function git(pi: ExtensionAPI, args: string[], cwd?: string) {
	return await pi.exec("git", args, cwd ? { cwd } : undefined);
}

export async function isGitRepository(pi: ExtensionAPI, cwd: string): Promise<boolean> {
	return (await git(pi, ["rev-parse", "--git-dir"], cwd)).code === 0;
}

export async function hasHeadCommit(pi: ExtensionAPI, cwd: string): Promise<boolean> {
	return (await git(pi, ["rev-parse", "--verify", "HEAD^{commit}"], cwd)).code === 0;
}

export async function hasWorkingTreeChanges(pi: ExtensionAPI, cwd: string): Promise<boolean> {
	const result = await git(pi, ["status", "--porcelain"], cwd);
	return result.code === 0 && result.stdout.trim().length > 0;
}

export async function getCurrentBranch(pi: ExtensionAPI, cwd?: string): Promise<string | null> {
	const result = await git(pi, ["branch", "--show-current"], cwd);
	return result.code === 0 ? result.stdout.trim() || null : null;
}

export async function getLocalBranches(pi: ExtensionAPI, cwd?: string): Promise<string[]> {
	const result = await git(pi, ["branch", "--format=%(refname:short)"], cwd);
	return result.code === 0
		? result.stdout.trim().split(/\r?\n/u).map((branch) => branch.trim()).filter(Boolean)
		: [];
}

export async function getRecentCommits(
	pi: ExtensionAPI,
	limit = 20,
	cwd?: string,
): Promise<Array<{ sha: string; title: string }>> {
	const result = await git(pi, ["log", "--oneline", "-n", String(limit)], cwd);
	if (result.code !== 0 || !result.stdout.trim()) return [];
	return result.stdout.trim().split(/\r?\n/u).map((line) => {
		const [sha, ...title] = line.trim().split(" ");
		return { sha, title: title.join(" ") };
	});
}

export async function getDefaultBranchInfo(pi: ExtensionAPI, cwd?: string): Promise<DefaultBranchInfo> {
	const result = await git(pi, ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"], cwd);
	if (result.code === 0 && result.stdout.trim()) {
		return { branch: result.stdout.trim().replace(/^origin\//u, ""), isReliable: true };
	}
	const branches = await getLocalBranches(pi, cwd);
	if (branches.includes("main")) return { branch: "main", isReliable: false };
	if (branches.includes("master")) return { branch: "master", isReliable: false };
	return { branch: "main", isReliable: false };
}

export async function getDefaultBranch(pi: ExtensionAPI, cwd?: string): Promise<string> {
	return (await getDefaultBranchInfo(pi, cwd)).branch;
}

export function parseDiffTargetArgs(args: string | undefined): DiffTarget | null {
	if (!args?.trim()) return null;
	const parts = args.trim().split(/\s+/u);
	switch ((parts[0] ?? "").toLowerCase()) {
		case "uncommitted":
			return { type: "uncommitted" };
		case "branch":
			return parts[1] ? { type: "baseBranch", branch: parts[1] } : null;
		case "commit":
			return parts[1]
				? { type: "commit", sha: parts[1], title: parts.slice(2).join(" ") || undefined }
				: null;
		default:
			return null;
	}
}

async function getSmartDefaultPreset(pi: ExtensionAPI, cwd: string): Promise<DiffTargetPreset> {
	if (await hasWorkingTreeChanges(pi, cwd)) return "uncommitted";
	const [currentBranch, branches, defaultBranch] = await Promise.all([
		getCurrentBranch(pi, cwd),
		getLocalBranches(pi, cwd),
		getDefaultBranchInfo(pi, cwd),
	]);
	if (!currentBranch || !branches.some((branch) => branch !== currentBranch) || !defaultBranch.isReliable) return "commit";
	return currentBranch === defaultBranch.branch ? "commit" : "baseBranch";
}

function orderPresets(smartDefault: DiffTargetPreset) {
	const presets = smartDefault === "uncommitted"
		? TARGET_PRESETS
		: TARGET_PRESETS.filter((preset) => preset.value !== "uncommitted");
	return [...presets].sort((left, right) => Number(right.value === smartDefault) - Number(left.value === smartDefault));
}

async function selectBranch(pi: ExtensionAPI, ctx: ExtensionContext): Promise<DiffTarget | null> {
	const [branches, currentBranch, defaultBranch] = await Promise.all([
		getLocalBranches(pi, ctx.cwd),
		getCurrentBranch(pi, ctx.cwd),
		getDefaultBranch(pi, ctx.cwd),
	]);
	const candidates = branches
		.filter((branch) => branch !== currentBranch)
		.sort((left, right) => left === defaultBranch ? -1 : right === defaultBranch ? 1 : left.localeCompare(right));
	if (candidates.length === 0) {
		ctx.ui.notify(currentBranch ? `No other branches found (current branch: ${currentBranch})` : "No branches found", "error");
		return null;
	}
	const labels = candidates.map((branch) => branch === defaultBranch ? `${branch} (default)` : branch);
	const selection = await ctx.ui.select("Select a branch to compare against", labels);
	const index = selection === undefined ? -1 : labels.indexOf(selection);
	return index < 0 ? null : { type: "baseBranch", branch: candidates[index]! };
}

async function selectCommit(pi: ExtensionAPI, ctx: ExtensionContext): Promise<DiffTarget | null> {
	const commits = await getRecentCommits(pi, 20, ctx.cwd);
	if (commits.length === 0) {
		ctx.ui.notify("No commits found", "error");
		return null;
	}
	const labels = commits.map((commit) => `${commit.sha.slice(0, 7)} ${commit.title}`.trim());
	const selection = await ctx.ui.select("Select a commit to review", labels);
	const index = selection === undefined ? -1 : labels.indexOf(selection);
	return index < 0 ? null : { type: "commit", ...commits[index]! };
}

async function selectTarget(pi: ExtensionAPI, ctx: ExtensionContext): Promise<DiffTarget | null> {
	const presets = orderPresets(await getSmartDefaultPreset(pi, ctx.cwd));
	while (true) {
		const labels = presets.map((preset) => preset.label);
		const selection = await ctx.ui.select("Select a diff target", labels);
		const preset = selection === undefined ? undefined : presets[labels.indexOf(selection)];
		if (!preset) return null;
		if (preset.value === "uncommitted") return { type: "uncommitted" };
		const target = preset.value === "baseBranch" ? await selectBranch(pi, ctx) : await selectCommit(pi, ctx);
		if (target) return target;
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
	if (trimmedArgs) {
		ctx.ui.notify("Invalid diff target. Use uncommitted, branch <name>, or commit <sha>.", "error");
		return null;
	}
	if (await hasWorkingTreeChanges(pi, ctx.cwd)) return { type: "uncommitted" };
	return await selectTarget(pi, ctx);
}
