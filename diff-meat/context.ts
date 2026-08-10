import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { DiffTarget } from "@siddr/pi-shared-qna/diff-target";

function messageText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } =>
			Boolean(part) && typeof part === "object" && part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

export function buildConversationContext(ctx: ExtensionContext): string {
	const turns: string[] = [];
	for (const entry of ctx.sessionManager.getBranch() as SessionEntry[]) {
		if (entry.type !== "message" || (entry.message.role !== "user" && entry.message.role !== "assistant")) continue;
		const text = messageText(entry.message.content);
		if (text) turns.push(`${entry.message.role === "user" ? "User" : "Assistant"}:\n${text}`);
	}
	return turns.join("\n\n");
}

async function resolveCommit(pi: ExtensionAPI, repoRoot: string, ref: string): Promise<string> {
	const result = await pi.exec("git", ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], { cwd: repoRoot });
	if (result.code !== 0 || !result.stdout.trim()) throw new Error(`Could not resolve commit context for ${ref}.`);
	return result.stdout.trim();
}

function parseCommitLog(output: string): string {
	const fields = output.split("\0");
	const commits: string[] = [];
	for (let index = 0; index + 1 < fields.length; index += 2) {
		const sha = fields[index]!.trim();
		const message = fields[index + 1]!.trim();
		if (sha && message) commits.push(`Commit ${sha}:\n${message}`);
	}
	return commits.join("\n\n");
}

export async function buildCommitContext(
	pi: ExtensionAPI,
	repoRoot: string,
	target: Exclude<DiffTarget, { type: "uncommitted" }>,
): Promise<string> {
	const ref = target.type === "baseBranch" ? target.branch : target.sha;
	const commit = await resolveCommit(pi, repoRoot, ref);
	const revision = target.type === "baseBranch" ? `${commit}..HEAD` : commit;
	const result = await pi.exec("git", ["log", "--format=%H%x00%B%x00", revision, "--"], { cwd: repoRoot });
	if (result.code !== 0) throw new Error(result.stderr.trim() || "Could not read commit messages for the diff.");
	return parseCommitLog(result.stdout);
}

export function buildDiffContext(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	repoRoot: string,
	target: DiffTarget,
): Promise<string> {
	return target.type === "uncommitted"
		? Promise.resolve(buildConversationContext(ctx))
		: buildCommitContext(pi, repoRoot, target);
}
