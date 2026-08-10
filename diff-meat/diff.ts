import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { prepareLocalReviewDiff } from "@plannotator/pi-extension/server.ts";
import type { DiffTarget } from "@siddr/pi-shared-qna/diff-target";
import { buildUntrackedFilesPatch } from "@siddr/pi-shared-qna/git-patch";
import type { PreparedDiff } from "./types";

async function getRepositoryRoot(pi: ExtensionAPI, cwd: string): Promise<string> {
	const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd });
	if (result.code !== 0 || !result.stdout.trim()) throw new Error("Could not resolve the git repository root.");
	return result.stdout.trim();
}

async function prepareUncommittedDiff(pi: ExtensionAPI, repoRoot: string): Promise<PreparedDiff> {
	const hasHead = (await pi.exec("git", ["rev-parse", "--verify", "HEAD^{commit}"], { cwd: repoRoot })).code === 0;
	let trackedPatch = "";
	if (hasHead) {
		const result = await pi.exec("git", ["diff", "--no-color", "--no-ext-diff", "HEAD", "--"], { cwd: repoRoot });
		if (result.code !== 0) throw new Error(result.stderr.trim() || "Could not read uncommitted changes.");
		trackedPatch = result.stdout.trimEnd();
	}
	const untrackedPatch = await buildUntrackedFilesPatch(pi, repoRoot);
	const rawPatch = [trackedPatch, untrackedPatch].filter((patch) => patch.trim()).join("\n");
	if (!rawPatch) throw new Error("No changes found for that diff target.");
	return { rawPatch: `${rawPatch}\n`, gitRef: "Uncommitted changes", diffType: "uncommitted", repoRoot };
}

export async function prepareDiff(pi: ExtensionAPI, cwd: string, target: DiffTarget): Promise<PreparedDiff> {
	const repoRoot = await getRepositoryRoot(pi, cwd);
	if (target.type === "uncommitted") return await prepareUncommittedDiff(pi, repoRoot);

	const diffType = target.type === "baseBranch" ? "merge-base" as const : `commit:${target.sha}` as const;
	const prepared = await prepareLocalReviewDiff({
		cwd: repoRoot,
		vcsType: "git",
		requestedDiffType: diffType,
		requestedBase: target.type === "baseBranch" ? target.branch : undefined,
		configuredDiffType: diffType,
		hideWhitespace: false,
	});
	if (prepared.error && !prepared.rawPatch.trim()) throw new Error(prepared.error);
	if (!prepared.rawPatch.trim()) throw new Error("No changes found for that diff target.");
	return { rawPatch: prepared.rawPatch, gitRef: prepared.gitRef, diffType, repoRoot };
}
