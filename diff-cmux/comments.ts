import type { DiffComment, DiffLineComment, ResolvedDiffTarget } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isNullableString(value: unknown): value is string | null | undefined {
	return value === null || value === undefined || typeof value === "string";
}

function compareFileScope(left: DiffComment, right: DiffComment): number {
	const leftPath = "path" in left ? left.path : "";
	const rightPath = "path" in right ? right.path : "";
	if (leftPath !== rightPath) {
		return leftPath.localeCompare(rightPath);
	}
	if (left.kind !== right.kind) {
		const order: Record<DiffComment["kind"], number> = {
			line: 0,
			file: 1,
			overall: 2,
		};
		return order[left.kind] - order[right.kind];
	}
	if (left.kind === "line" && right.kind === "line") {
		if (left.lineNumber !== right.lineNumber) {
			return left.lineNumber - right.lineNumber;
		}
		if (left.side !== right.side) {
			return left.side.localeCompare(right.side);
		}
	}
	return left.createdAt - right.createdAt;
}

function formatDisplayPath(filePath: string): string {
	return filePath.startsWith("./") ? filePath : `./${filePath}`;
}

function formatLineReference(comment: DiffLineComment): string {
	return `${formatDisplayPath(comment.path)}:${comment.lineNumber} (${comment.side === "old" ? "old" : "new"})`;
}

export function isDiffComment(value: unknown): value is DiffComment {
	if (!isRecord(value)) {
		return false;
	}
	if (!isNonEmptyString(value.id) || !isNonEmptyString(value.text)) {
		return false;
	}
	if (typeof value.createdAt !== "number" || typeof value.updatedAt !== "number") {
		return false;
	}
	if (value.sentAt !== null && typeof value.sentAt !== "number") {
		return false;
	}

	if (value.kind === "overall") {
		return true;
	}

	if (value.kind === "file") {
		return isNonEmptyString(value.fileId) && isNonEmptyString(value.path) && isNullableString(value.oldPath) && isNullableString(value.newPath);
	}

	if (value.kind === "line") {
		return (
			isNonEmptyString(value.fileId) &&
			isNonEmptyString(value.path) &&
			(value.side === "old" || value.side === "new") &&
			typeof value.lineNumber === "number" &&
			value.lineNumber > 0 &&
			isNonEmptyString(value.changeKey) &&
			(typeof value.excerpt === "undefined" || typeof value.excerpt === "string") &&
			isNullableString(value.oldPath) &&
			isNullableString(value.newPath)
		);
	}

	return false;
}

export function validateDiffComments(value: unknown): DiffComment[] {
	if (!Array.isArray(value)) {
		throw new Error("Expected an array of comments.");
	}
	const comments = value.filter(isDiffComment);
	if (comments.length !== value.length) {
		throw new Error("One or more comments were invalid.");
	}
	return comments;
}

export function hasMeaningfulText(text: string): boolean {
	return text.trim().length > 0;
}

export function isEmptyDraftComment(comment: DiffComment): boolean {
	return comment.sentAt === null && !hasMeaningfulText(comment.text);
}

export function findReusableDraftComment(
	comments: DiffComment[],
	target:
		| { kind: "overall" }
		| { kind: "file"; fileId: string }
		| { kind: "line"; fileId: string; changeKey: string },
): DiffComment | null {
	for (const comment of comments) {
		if (comment.kind !== target.kind || !isEmptyDraftComment(comment)) {
			continue;
		}
		if (target.kind === "overall") {
			return comment;
		}
		if (comment.fileId !== target.fileId) {
			continue;
		}
		if (target.kind === "line") {
			if (comment.kind === "line" && comment.changeKey === target.changeKey) {
				return comment;
			}
			continue;
		}
		return comment;
	}
	return null;
}

export function removeCommentById(comments: DiffComment[], commentId: string): DiffComment[] {
	return comments.filter((comment) => comment.id !== commentId);
}

export function appendTextToEditor(editorText: string, nextText: string): string {
	if (!hasMeaningfulText(editorText)) {
		return nextText;
	}
	const normalizedEditorText = editorText.replace(/(?:\r?\n)+$/u, "");
	const normalizedNextText = nextText.replace(/^(?:\r?\n)+/u, "");
	return `${normalizedEditorText}\n${normalizedNextText}`;
}

function appendCommentsBlockToEditor(editorText: string, commentText: string): string {
	if (!hasMeaningfulText(editorText)) {
		return commentText;
	}
	const normalizedEditorText = editorText.replace(/(?:\r?\n)+$/u, "");
	const normalizedCommentText = commentText.replace(/^(?:\r?\n)+/u, "");
	return `${normalizedEditorText}\n\n${normalizedCommentText}`;
}

export function updateCommentText<T extends DiffComment>(comment: T, text: string): T {
	if (comment.text === text) {
		return comment;
	}
	return {
		...comment,
		text,
		updatedAt: Date.now(),
		sentAt: null,
	};
}

export function formatCommentsForEditor(_target: ResolvedDiffTarget, comments: DiffComment[]): string {
	const scopedComments = comments.filter((comment) => hasMeaningfulText(comment.text));
	const overallComments = scopedComments
		.filter((comment): comment is Extract<DiffComment, { kind: "overall" }> => comment.kind === "overall")
		.sort((left, right) => left.createdAt - right.createdAt);
	const reviewComments = scopedComments.filter((comment) => comment.kind !== "overall").sort(compareFileScope);
	const lines: string[] = [];

	for (const comment of overallComments) {
		lines.push(comment.text.trim(), "");
	}

	for (const comment of reviewComments) {
		const location = comment.kind === "line" ? formatLineReference(comment) : formatDisplayPath(comment.path);
		lines.push(location);
		for (const textLine of comment.text.trim().split(/\r?\n/)) {
			lines.push(`   ${textLine}`);
		}
		lines.push("");
	}

	return `${lines.join("\n").trim()}\n`;
}

export async function appendCommentsToEditor(
	ui: {
		getEditorText: () => string;
		setEditorText: (value: string) => void | Promise<void>;
	},
	target: ResolvedDiffTarget,
	comments: DiffComment[],
): Promise<string> {
	const formatted = formatCommentsForEditor(target, comments);
	const formattedForEditor = `${formatted}\n`;
	const nextText = appendCommentsBlockToEditor(ui.getEditorText(), formattedForEditor);
	await ui.setEditorText(nextText);
	return formattedForEditor;
}
