import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ExecResult = {
	stdout: string;
	stderr: string;
	code: number;
	killed?: boolean;
};

export type DefaultBranchInfo = {
	branch: string;
	isReliable: boolean;
};

async function exec(pi: ExtensionAPI, command: string, args: string[], cwd?: string): Promise<ExecResult> {
	return await pi.exec(command, args, cwd ? { cwd } : undefined);
}

export async function isGitRepository(pi: ExtensionAPI, cwd: string): Promise<boolean> {
	const { code } = await exec(pi, "git", ["rev-parse", "--git-dir"], cwd);
	return code === 0;
}

export async function hasHeadCommit(pi: ExtensionAPI, cwd: string): Promise<boolean> {
	const { code } = await exec(pi, "git", ["rev-parse", "--verify", "HEAD^{commit}"], cwd);
	return code === 0;
}

export async function hasWorkingTreeChanges(pi: ExtensionAPI, cwd: string): Promise<boolean> {
	const { stdout, code } = await exec(pi, "git", ["status", "--porcelain"], cwd);
	return code === 0 && stdout.trim().length > 0;
}

export async function getCurrentBranch(pi: ExtensionAPI, cwd?: string): Promise<string | null> {
	const { stdout, code } = await exec(pi, "git", ["branch", "--show-current"], cwd);
	if (code !== 0) {
		return null;
	}
	const branch = stdout.trim();
	return branch || null;
}

export async function getLocalBranches(pi: ExtensionAPI, cwd?: string): Promise<string[]> {
	const { stdout, code } = await exec(pi, "git", ["branch", "--format=%(refname:short)"], cwd);
	if (code !== 0 || !stdout.trim()) {
		return [];
	}
	return stdout
		.trim()
		.split(/\r?\n/)
		.map((branch) => branch.trim())
		.filter((branch) => branch.length > 0);
}

export async function getRecentCommits(pi: ExtensionAPI, limit = 20, cwd?: string): Promise<Array<{ sha: string; title: string }>> {
	const { stdout, code } = await exec(pi, "git", ["log", "--oneline", "-n", String(limit)], cwd);
	if (code !== 0 || !stdout.trim()) {
		return [];
	}
	return stdout
		.trim()
		.split(/\r?\n/)
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

export async function getDefaultBranchInfo(pi: ExtensionAPI, cwd?: string): Promise<DefaultBranchInfo> {
	const { stdout, code } = await exec(pi, "git", ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"], cwd);
	if (code === 0 && stdout.trim()) {
		return {
			branch: stdout.trim().replace(/^origin\//, ""),
			isReliable: true,
		};
	}

	const branches = await getLocalBranches(pi, cwd);
	if (branches.includes("main")) {
		return { branch: "main", isReliable: false };
	}
	if (branches.includes("master")) {
		return { branch: "master", isReliable: false };
	}
	return { branch: "main", isReliable: false };
}

export async function getDefaultBranch(pi: ExtensionAPI, cwd?: string): Promise<string> {
	return (await getDefaultBranchInfo(pi, cwd)).branch;
}
