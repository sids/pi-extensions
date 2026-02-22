import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { parsePrReference } from "./utils";

async function exec(pi: ExtensionAPI, command: string, args: string[], cwd?: string) {
	return pi.exec(command, args, cwd ? { cwd } : undefined);
}

export async function isGitRepository(pi: ExtensionAPI, cwd: string): Promise<boolean> {
	const { code } = await exec(pi, "git", ["rev-parse", "--git-dir"], cwd);
	return code === 0;
}

export async function getMergeBase(pi: ExtensionAPI, branch: string, cwd?: string): Promise<string | null> {
	try {
		const { stdout: upstream, code: upstreamCode } = await exec(pi, "git", [
			"rev-parse",
			"--abbrev-ref",
			`${branch}@{upstream}`,
		], cwd);

		if (upstreamCode === 0 && upstream.trim()) {
			const { stdout: mergeBase, code } = await exec(pi, "git", ["merge-base", "HEAD", upstream.trim()], cwd);
			if (code === 0 && mergeBase.trim()) {
				return mergeBase.trim();
			}
		}

		const { stdout: mergeBase, code } = await exec(pi, "git", ["merge-base", "HEAD", branch], cwd);
		if (code === 0 && mergeBase.trim()) {
			return mergeBase.trim();
		}
		return null;
	} catch {
		return null;
	}
}

export async function getLocalBranches(pi: ExtensionAPI, cwd?: string): Promise<string[]> {
	const { stdout, code } = await exec(pi, "git", ["branch", "--format=%(refname:short)"], cwd);
	if (code !== 0) {
		return [];
	}
	return stdout
		.trim()
		.split("\n")
		.map((branch) => branch.trim())
		.filter((branch) => branch.length > 0);
}

export async function getRecentCommits(
	pi: ExtensionAPI,
	limit: number = 20,
	cwd?: string,
): Promise<Array<{ sha: string; title: string }>> {
	const { stdout, code } = await exec(pi, "git", ["log", "--oneline", "-n", String(limit)], cwd);
	if (code !== 0) {
		return [];
	}

	return stdout
		.trim()
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => {
			const [sha, ...titleParts] = line.split(" ");
			return {
				sha,
				title: titleParts.join(" "),
			};
		});
}

export async function hasUncommittedChanges(pi: ExtensionAPI, cwd?: string): Promise<boolean> {
	const { stdout, code } = await exec(pi, "git", ["status", "--porcelain"], cwd);
	return code === 0 && stdout.trim().length > 0;
}

export async function hasPendingChanges(pi: ExtensionAPI, cwd?: string): Promise<boolean> {
	const { stdout, code } = await exec(pi, "git", ["status", "--porcelain"], cwd);
	if (code !== 0) {
		return false;
	}

	const lines = stdout
		.trim()
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	const trackedChanges = lines.filter((line) => !line.startsWith("??"));
	return trackedChanges.length > 0;
}

export async function getPrInfo(
	pi: ExtensionAPI,
	prRef: number | string,
	cwd?: string,
): Promise<{ baseBranch: string; title: string; headBranch: string } | null> {
	const { stdout, code } = await exec(
		pi,
		"gh",
		["pr", "view", String(prRef), "--json", "baseRefName,title,headRefName"],
		cwd,
	);
	if (code !== 0) {
		return null;
	}

	try {
		const parsed = JSON.parse(stdout) as {
			baseRefName?: string;
			title?: string;
			headRefName?: string;
		};
		if (!parsed.baseRefName || !parsed.title || !parsed.headRefName) {
			return null;
		}
		return {
			baseBranch: parsed.baseRefName,
			title: parsed.title,
			headBranch: parsed.headRefName,
		};
	} catch {
		return null;
	}
}

export async function checkoutPr(
	pi: ExtensionAPI,
	prRef: number | string,
	cwd?: string,
): Promise<{ success: boolean; error?: string }> {
	const { stdout, stderr, code } = await exec(pi, "gh", ["pr", "checkout", String(prRef)], cwd);
	if (code !== 0) {
		return {
			success: false,
			error: stderr || stdout || "Failed to checkout PR",
		};
	}

	return { success: true };
}

export async function getCurrentBranch(pi: ExtensionAPI, cwd?: string): Promise<string | null> {
	const { stdout, code } = await exec(pi, "git", ["branch", "--show-current"], cwd);
	if (code !== 0) {
		return null;
	}
	const branch = stdout.trim();
	return branch || null;
}

export type DefaultBranchInfo = {
	branch: string;
	isReliable: boolean;
};

export async function getDefaultBranchInfo(pi: ExtensionAPI, cwd?: string): Promise<DefaultBranchInfo> {
	const { stdout, code } = await exec(pi, "git", ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"], cwd);
	if (code === 0 && stdout.trim()) {
		return {
			branch: stdout.trim().replace("origin/", ""),
			isReliable: true,
		};
	}

	const branches = await getLocalBranches(pi, cwd);
	if (branches.includes("main")) {
		return {
			branch: "main",
			isReliable: false,
		};
	}
	if (branches.includes("master")) {
		return {
			branch: "master",
			isReliable: false,
		};
	}
	return {
		branch: "main",
		isReliable: false,
	};
}

export async function getDefaultBranch(pi: ExtensionAPI, cwd?: string): Promise<string> {
	return (await getDefaultBranchInfo(pi, cwd)).branch;
}

export { parsePrReference };
