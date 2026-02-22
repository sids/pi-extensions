import { promises as fs } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getMergeBase } from "./git";
import type { ReviewTarget } from "./types";
import { getReviewTargetHint } from "./utils";

const UNCOMMITTED_PROMPT =
	"Review the current code changes (staged, unstaged, and untracked files) and provide prioritized findings.";

const BASE_BRANCH_PROMPT_WITH_MERGE_BASE =
	"Review the code changes against the base branch '{baseBranch}'. The merge base commit for this comparison is {mergeBaseSha}. Run `git diff {mergeBaseSha}` to inspect the changes relative to {baseBranch}. Provide prioritized, actionable findings.";

const BASE_BRANCH_PROMPT_FALLBACK =
	"Review the code changes against the base branch '{branch}'. Start by finding the merge diff between the current branch and {branch}'s upstream e.g. (`git merge-base HEAD \"$(git rev-parse --abbrev-ref \"{branch}@{upstream}\")\"`), then run `git diff` against that SHA to see what changes we would merge into the {branch} branch. Provide prioritized, actionable findings.";

const COMMIT_PROMPT_WITH_TITLE =
	'Review the code changes introduced by commit {sha} ("{title}"). Provide prioritized, actionable findings.';

const COMMIT_PROMPT = "Review the code changes introduced by commit {sha}. Provide prioritized, actionable findings.";

const PULL_REQUEST_PROMPT =
	"Review pull request #{prNumber} (\"{title}\") against the base branch '{baseBranch}'. The merge base commit for this comparison is {mergeBaseSha}. Run `git diff {mergeBaseSha}` to inspect the changes that would be merged. Provide prioritized, actionable findings.";

const PULL_REQUEST_PROMPT_FALLBACK =
	"Review pull request #{prNumber} (\"{title}\") against the base branch '{baseBranch}'. Start by finding the merge base between the current branch and {baseBranch} (e.g., `git merge-base HEAD {baseBranch}`), then run `git diff` against that SHA to see the changes that would be merged. Provide prioritized, actionable findings.";

const FOLDER_REVIEW_PROMPT =
	"Review the code in the following paths: {paths}. This is a snapshot review (not a diff). Read the files directly in these paths and provide prioritized, actionable findings.";

export const REVIEW_RUBRIC = `# Review Guidelines

You are acting as a code reviewer for a proposed code change made by another engineer.

Below are default guidelines for determining what to flag. These are not the final word — if you encounter more specific guidelines elsewhere (in a developer message, user message, file, or project review guidelines appended below), those override these general instructions.

## Determining what to flag

Flag issues that:
1. Meaningfully impact the accuracy, performance, security, or maintainability of the code.
2. Are discrete and actionable (not general issues or multiple combined issues).
3. Don't demand rigor inconsistent with the rest of the codebase.
4. Were introduced in the changes being reviewed (not pre-existing bugs).
5. The author would likely fix if aware of them.
6. Don't rely on unstated assumptions about the codebase or author's intent.
7. Have provable impact on other parts of the code — it is not enough to speculate that a change may disrupt another part, you must identify the parts that are provably affected.
8. Are clearly not intentional changes by the author.
9. Be particularly careful with untrusted user input and follow the specific guidelines to review.

## Untrusted User Input

1. Be careful with open redirects, they must always be checked to only go to trusted domains (?next_page=...)
2. Always flag SQL that is not parametrized
3. In systems with user supplied URL input, http fetches always need to be protected against access to local resources (intercept DNS resolver!)
4. Escape, don't sanitize if you have the option (eg: HTML escaping)

## Comment guidelines

1. Be clear about why the issue is a problem.
2. Communicate severity appropriately - don't exaggerate.
3. Be brief - at most 1 paragraph.
4. Keep code snippets under 3 lines, wrapped in inline code or code blocks.
5. Use \`\`\`suggestion blocks ONLY for concrete replacement code (minimal lines; no commentary inside the block). Preserve the exact leading whitespace of the replaced lines.
6. Explicitly state scenarios/environments where the issue arises.
7. Use a matter-of-fact tone - helpful AI assistant, not accusatory.
8. Write for quick comprehension without close reading.
9. Avoid excessive flattery or unhelpful phrases like "Great job...".

## Review priorities

1. Call out newly added dependencies explicitly and explain why they're needed.
2. Prefer simple, direct solutions over wrappers or abstractions without clear value.
3. Favor fail-fast behavior; avoid logging-and-continue patterns that hide errors.
4. Prefer predictable production behavior; crashing is better than silent degradation.
5. Treat back pressure handling as critical to system stability.
6. Apply system-level thinking; flag changes that increase operational risk or on-call wakeups.
7. Ensure that errors are always checked against codes or stable identifiers, never error messages.

## Priority levels

Assign one priority level to each finding using add_review_comment.priority:
- P0 - Drop everything to fix. Blocking release/operations. Only for universal issues that do not depend on assumptions about inputs.
- P1 - Urgent. Should be addressed in the next cycle.
- P2 - Normal. To be fixed eventually.
- P3 - Low. Nice to have.

## Output format

Collect findings using the add_review_comment tool:
1. For each qualifying finding, call add_review_comment exactly once.
2. Use priority values P0, P1, P2, or P3.
3. Put only the finding text in comment; do not include priority tags like [P1] in comment.
4. Include precise references as filePath + startLine (+ optional endLine).
5. Do not batch multiple unrelated issues into one tool call.
6. If no findings qualify, state that the code looks good and do not call add_review_comment.
`;

export async function loadProjectReviewGuidelines(cwd: string): Promise<string | null> {
	let currentDir = path.resolve(cwd);

	while (true) {
		const piDir = path.join(currentDir, ".pi");
		const guidelinesPath = path.join(currentDir, "REVIEW_GUIDELINES.md");

		const piStats = await fs.stat(piDir).catch(() => null);
		if (piStats?.isDirectory()) {
			const guidelineStats = await fs.stat(guidelinesPath).catch(() => null);
			if (!guidelineStats?.isFile()) {
				return null;
			}

			try {
				const content = await fs.readFile(guidelinesPath, "utf8");
				const trimmed = content.trim();
				return trimmed.length > 0 ? trimmed : null;
			} catch {
				return null;
			}
		}

		const parent = path.dirname(currentDir);
		if (parent === currentDir) {
			return null;
		}
		currentDir = parent;
	}
}

export async function buildReviewTargetPrompt(pi: ExtensionAPI, target: ReviewTarget, cwd?: string): Promise<string> {
	switch (target.type) {
		case "uncommitted":
			return UNCOMMITTED_PROMPT;
		case "baseBranch": {
			const mergeBase = await getMergeBase(pi, target.branch, cwd);
			if (mergeBase) {
				return BASE_BRANCH_PROMPT_WITH_MERGE_BASE.replace(/{baseBranch}/g, target.branch).replace(
					/{mergeBaseSha}/g,
					mergeBase,
				);
			}
			return BASE_BRANCH_PROMPT_FALLBACK.replace(/{branch}/g, target.branch);
		}
		case "commit":
			if (target.title) {
				return COMMIT_PROMPT_WITH_TITLE.replace("{sha}", target.sha).replace("{title}", target.title);
			}
			return COMMIT_PROMPT.replace("{sha}", target.sha);
		case "custom":
			return target.instructions;
		case "pullRequest": {
			const mergeBase = await getMergeBase(pi, target.baseBranch, cwd);
			if (mergeBase) {
				return PULL_REQUEST_PROMPT.replace(/{prNumber}/g, String(target.prNumber))
					.replace(/{title}/g, target.title)
					.replace(/{baseBranch}/g, target.baseBranch)
					.replace(/{mergeBaseSha}/g, mergeBase);
			}
			return PULL_REQUEST_PROMPT_FALLBACK.replace(/{prNumber}/g, String(target.prNumber))
				.replace(/{title}/g, target.title)
				.replace(/{baseBranch}/g, target.baseBranch);
		}
		case "folder":
			return FOLDER_REVIEW_PROMPT.replace("{paths}", target.paths.join(", "));
	}
}

function buildReviewImportantLines(): string[] {
	return [
		"Important:",
		"- Use add_review_comment once for each finding you decide to keep.",
		"- Set priority only in add_review_comment.priority; do not add [P0-P3] to comment text.",
		"- Provide references with exact filePath/startLine/endLine when possible.",
		"- If no actionable findings exist, say so explicitly.",
	];
}

export async function buildReviewInstructionsPrompt(cwd: string): Promise<string> {
	const projectGuidelines = await loadProjectReviewGuidelines(cwd);
	const lines = [REVIEW_RUBRIC, "", ...buildReviewImportantLines()];

	if (projectGuidelines) {
		lines.push("");
		lines.push("This project has additional instructions for code reviews:");
		lines.push("");
		lines.push(projectGuidelines);
	}

	return lines.join("\n");
}

export async function buildReviewEditorPrompt(pi: ExtensionAPI, cwd: string, target: ReviewTarget): Promise<string> {
	const targetPrompt = await buildReviewTargetPrompt(pi, target, cwd);
	return ["Please perform a code review with the following focus:", "", targetPrompt].join("\n");
}

export async function buildReviewUserPrompt(pi: ExtensionAPI, cwd: string, target: ReviewTarget): Promise<string> {
	const instructionsPrompt = await buildReviewInstructionsPrompt(cwd);
	const editorPrompt = await buildReviewEditorPrompt(pi, cwd, target);
	return [instructionsPrompt, "", "---", "", editorPrompt].join("\n");
}

export function describeReviewTarget(target: ReviewTarget): string {
	return getReviewTargetHint(target);
}
