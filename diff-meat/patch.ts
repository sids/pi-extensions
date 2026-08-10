type LineMarker = " " | "+" | "-";

export type PatchLine = {
	lineNo: number;
	text: string;
	marker: LineMarker;
	oldBefore: number;
	newBefore: number;
	oldDelta: 0 | 1;
	newDelta: 0 | 1;
	noNewlineMarker?: string;
};

export type PatchHunk = {
	id: string;
	fileId: string;
	headerSuffix: string;
	lines: PatchLine[];
};

export type PatchFile = {
	id: string;
	label: string;
	header: string[];
	hunks: PatchHunk[];
	raw: string;
};

export type PatchDocument = {
	files: PatchFile[];
	linesByNumber: Map<number, { hunk: PatchHunk; line: PatchLine }>;
};

type RemoveOperation = { startLine: number; endLine: number };
type FoldOperation = { startLine: number; endLine: number };
type ReplaceOperation = { line: number; old: string; new: string };
export type DiffEditPlan = {
	remove: RemoveOperation[];
	fold: FoldOperation[];
	replace: ReplaceOperation[];
	dropFiles: string[];
	summary: string;
};

type CompiledReadingDiff = {
	rawPatch: string;
	keptSections: number;
	totalSections: number;
};

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/u;

function splitLines(raw: string): string[] {
	const normalized = raw.replace(/\r\n/gu, "\n");
	const lines = normalized.split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines;
}

function parseHunk(
	lines: string[],
	start: number,
	end: number,
	fileId: string,
	hunkIndex: number,
): PatchHunk {
	const match = lines[start]!.match(HUNK_HEADER);
	if (!match) {
		throw new Error(`Unsupported unified diff hunk header on line ${start + 1}.`);
	}
	let oldCursor = Number.parseInt(match[1]!, 10);
	let newCursor = Number.parseInt(match[3]!, 10);
	const parsed: PatchLine[] = [];
	for (let index = start + 1; index < end; index++) {
		const text = lines[index]!;
		if (text.startsWith("\\ No newline at end of file")) {
			const owner = parsed.at(-1);
			if (owner) owner.noNewlineMarker = text;
			continue;
		}
		const marker = text[0];
		if (marker !== " " && marker !== "+" && marker !== "-") {
			throw new Error(`Unsupported unified diff source line ${index + 1}.`);
		}
		const oldDelta = marker === "+" ? 0 : 1;
		const newDelta = marker === "-" ? 0 : 1;
		parsed.push({
			lineNo: index + 1,
			text,
			marker,
			oldBefore: oldCursor,
			newBefore: newCursor,
			oldDelta,
			newDelta,
		});
		oldCursor += oldDelta;
		newCursor += newDelta;
	}
	return {
		id: `${fileId}:H${hunkIndex + 1}`,
		fileId,
		headerSuffix: match[5] ?? "",
		lines: parsed,
	};
}

export function parsePatch(rawPatch: string): PatchDocument {
	const lines = splitLines(rawPatch);
	const fileStarts = lines
		.map((line, index) => line.startsWith("diff --git ") ? index : -1)
		.filter((index) => index >= 0);
	if (fileStarts.length === 0) {
		throw new Error("The selected changes are not a supported git patch.");
	}

	const files: PatchFile[] = [];
	const linesByNumber = new Map<number, { hunk: PatchHunk; line: PatchLine }>();
	for (let fileIndex = 0; fileIndex < fileStarts.length; fileIndex++) {
		const start = fileStarts[fileIndex]!;
		const end = fileStarts[fileIndex + 1] ?? lines.length;
		const fileLines = lines.slice(start, end);
		const localHunkStarts = fileLines
			.map((line, index) => line.startsWith("@@ ") ? start + index : -1)
			.filter((index) => index >= 0);
		if (fileLines.some((line) => line.startsWith("@@@ "))) {
			throw new Error("Combined merge diffs are not supported by diff-meat.");
		}
		const fileId = `F${fileIndex + 1}`;
		const firstLine = lines[start] ?? `file ${fileIndex + 1}`;
		const file: PatchFile = {
			id: fileId,
			label: firstLine.replace(/^diff --git\s+/u, ""),
			header: lines.slice(start, localHunkStarts[0] ?? end),
			hunks: [],
			raw: `${lines.slice(start, end).join("\n")}\n`,
		};
		for (let hunkIndex = 0; hunkIndex < localHunkStarts.length; hunkIndex++) {
			const hunk = parseHunk(lines, localHunkStarts[hunkIndex]!, localHunkStarts[hunkIndex + 1] ?? end, fileId, hunkIndex);
			file.hunks.push(hunk);
			for (const line of hunk.lines) linesByNumber.set(line.lineNo, { hunk, line });
		}
		files.push(file);
	}
	return { files, linesByNumber };
}

function uniqueSubstringIndex(text: string, substring: string): number {
	const first = text.indexOf(substring);
	if (first < 0 || text.indexOf(substring, first + 1) >= 0) return -1;
	return first;
}

function isElisionProjection(oldText: string, newText: string): boolean {
	const pieces = newText.split(/(?:\.\.\.|…)/u);
	if (pieces.length < 2) return false;
	let cursor = 0;
	let omitted = false;
	for (let index = 0; index < pieces.length; index++) {
		const piece = pieces[index]!;
		const found = oldText.indexOf(piece, cursor);
		if (found < 0) return false;
		if (index > 0 && found > cursor) omitted = true;
		cursor = found + piece.length;
	}
	if (cursor < oldText.length) omitted = true;
	return omitted;
}

function operationLines(
	document: PatchDocument,
	startLine: number,
	endLine: number,
	allowedLines?: Set<number>,
): Array<{ hunk: PatchHunk; line: PatchLine }> {
	if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
		throw new Error(`Invalid inclusive line range ${startLine}-${endLine}.`);
	}
	const result: Array<{ hunk: PatchHunk; line: PatchLine }> = [];
	for (let lineNo = startLine; lineNo <= endLine; lineNo++) {
		if (allowedLines && !allowedLines.has(lineNo)) {
			throw new Error(`Line ${lineNo} is outside the current diff chunk.`);
		}
		const entry = document.linesByNumber.get(lineNo);
		if (!entry) throw new Error(`Line ${lineNo} is not editable hunk source.`);
		result.push(entry);
	}
	if (result.some((entry) => entry.hunk !== result[0]!.hunk)) {
		throw new Error(`Range ${startLine}-${endLine} crosses diff hunks.`);
	}
	return result;
}

export function validatePlan(
	document: PatchDocument,
	plan: DiffEditPlan,
	options: { allowedLines?: Set<number>; allowedFiles?: Set<string> } = {},
): void {
	if (!plan.summary.trim() || plan.summary.includes("\n") || plan.summary.length > 500) {
		throw new Error("Plan summary must be a non-empty single line of at most 500 characters.");
	}
	const occupied = new Set<number>();
	const claim = (lineNo: number, kind: string) => {
		if (occupied.has(lineNo)) throw new Error(`${kind} overlaps another edit on line ${lineNo}.`);
		occupied.add(lineNo);
	};
	for (const range of plan.remove) {
		for (const { line } of operationLines(document, range.startLine, range.endLine, options.allowedLines)) {
			claim(line.lineNo, "remove");
		}
	}
	for (const range of plan.fold) {
		const entries = operationLines(document, range.startLine, range.endLine, options.allowedLines);
		if (entries.length < 2) throw new Error(`Fold ${range.startLine}-${range.endLine} must contain at least two lines.`);
		const marker = entries[0]!.line.marker;
		if (entries.some((entry) => entry.line.marker !== marker)) {
			throw new Error(`Fold ${range.startLine}-${range.endLine} mixes diff markers.`);
		}
		for (const { line } of entries) claim(line.lineNo, "fold");
	}
	for (const replacement of plan.replace) {
		const [{ line }] = operationLines(document, replacement.line, replacement.line, options.allowedLines);
		claim(line.lineNo, "replace");
		if (!replacement.old || replacement.old.includes("\n") || replacement.new.includes("\n")) {
			throw new Error(`Replacement on line ${replacement.line} must use single-line text.`);
		}
		const body = line.text.slice(1);
		if (uniqueSubstringIndex(body, replacement.old) < 0) {
			throw new Error(`Replacement old text must occur exactly once on line ${replacement.line}.`);
		}
		if (!isElisionProjection(replacement.old, replacement.new)) {
			throw new Error(`Replacement on line ${replacement.line} must preserve source text around an ellipsis.`);
		}
	}
	const knownFiles = new Set(document.files.map((file) => file.id));
	for (const fileId of plan.dropFiles) {
		if (!knownFiles.has(fileId)) throw new Error(`Unknown file id ${fileId}.`);
		if (options.allowedFiles && !options.allowedFiles.has(fileId)) {
			throw new Error(`File ${fileId} is outside the current diff chunk.`);
		}
	}
}

type RenderedLine = PatchLine & { renderedText: string };

function foldText(lines: PatchLine[]): string {
	const bodies = lines.map((line) => line.text.slice(1)).filter((line) => line.trim());
	let indent = bodies[0]?.match(/^\s*/u)?.[0] ?? "";
	for (const body of bodies.slice(1)) {
		const next = body.match(/^\s*/u)?.[0] ?? "";
		let length = 0;
		while (length < indent.length && length < next.length && indent[length] === next[length]) length++;
		indent = indent.slice(0, length);
	}
	return `${lines[0]!.marker}${indent}...`;
}

function formatRange(start: number, count: number): string {
	if (count === 1) return String(start);
	return `${start},${count}`;
}

function renderHunk(hunk: PatchHunk, plan: DiffEditPlan): string {
	const removed = new Set<number>();
	for (const range of plan.remove) {
		for (let line = range.startLine; line <= range.endLine; line++) removed.add(line);
	}
	const folds = new Map<number, FoldOperation>();
	const foldedLines = new Set<number>();
	for (const fold of plan.fold) {
		folds.set(fold.startLine, fold);
		for (let line = fold.startLine; line <= fold.endLine; line++) foldedLines.add(line);
	}
	const replacements = new Map(plan.replace.map((replacement) => [replacement.line, replacement]));
	const records: RenderedLine[] = [];
	for (const line of hunk.lines) {
		if (removed.has(line.lineNo)) continue;
		const fold = folds.get(line.lineNo);
		if (fold) {
			const source = hunk.lines.filter((candidate) => candidate.lineNo >= fold.startLine && candidate.lineNo <= fold.endLine);
			records.push({
				...line,
				renderedText: foldText(source),
				oldDelta: line.marker === "+" ? 0 : 1,
				newDelta: line.marker === "-" ? 0 : 1,
				noNewlineMarker: undefined,
			});
			continue;
		}
		if (foldedLines.has(line.lineNo)) continue;
		const replacement = replacements.get(line.lineNo);
		let renderedText = line.text;
		if (replacement) {
			const body = line.text.slice(1);
			const index = body.indexOf(replacement.old);
			renderedText = `${line.marker}${body.slice(0, index)}${replacement.new}${body.slice(index + replacement.old.length)}`;
		}
		records.push({ ...line, renderedText });
	}

	const segments: RenderedLine[][] = [];
	for (const record of records) {
		const segment = segments.at(-1);
		const previous = segment?.at(-1);
		if (!previous || previous.oldBefore + previous.oldDelta !== record.oldBefore || previous.newBefore + previous.newDelta !== record.newBefore) {
			segments.push([record]);
		} else {
			segment!.push(record);
		}
	}
	const meaningful = segments.filter((segment) => segment.some((line) => line.marker === "+" || line.marker === "-"));
	return meaningful.map((segment) => {
		const first = segment[0]!;
		const oldCount = segment.reduce((count, line) => count + line.oldDelta, 0);
		const newCount = segment.reduce((count, line) => count + line.newDelta, 0);
		const oldStart = oldCount === 0 ? Math.max(0, first.oldBefore - 1) : first.oldBefore;
		const newStart = newCount === 0 ? Math.max(0, first.newBefore - 1) : first.newBefore;
		const body: string[] = [];
		for (const line of segment) {
			body.push(line.renderedText);
			if (line.noNewlineMarker) body.push(line.noNewlineMarker);
		}
		return `@@ -${formatRange(oldStart, oldCount)} +${formatRange(newStart, newCount)} @@${hunk.headerSuffix}\n${body.join("\n")}`;
	}).join("\n");
}

export function compileReadingDiff(document: PatchDocument, plan: DiffEditPlan): CompiledReadingDiff {
	validatePlan(document, plan);
	const dropped = new Set(plan.dropFiles);
	const output: string[] = [];
	let keptSections = 0;
	const totalSections = document.files.reduce((count, file) => count + Math.max(1, file.hunks.length), 0);
	for (const file of document.files) {
		if (dropped.has(file.id)) continue;
		if (file.hunks.length === 0) {
			output.push(file.raw.trimEnd());
			keptSections++;
			continue;
		}
		const renderedHunks = file.hunks.map((hunk) => renderHunk(hunk, plan)).filter(Boolean);
		if (renderedHunks.length === 0) continue;
		output.push(file.header.join("\n").trimEnd(), ...renderedHunks);
		keptSections += renderedHunks.length;
	}
	return {
		rawPatch: output.length > 0 ? `${output.join("\n")}\n` : "",
		keptSections,
		totalSections,
	};
}

export function mergePlans(plans: DiffEditPlan[], summary: string): DiffEditPlan {
	return {
		remove: plans.flatMap((plan) => plan.remove),
		fold: plans.flatMap((plan) => plan.fold),
		replace: plans.flatMap((plan) => plan.replace),
		dropFiles: [...new Set(plans.flatMap((plan) => plan.dropFiles))],
		summary,
	};
}

export function numberedPatchForHunks(document: PatchDocument, hunkIds: Set<string>, fileIds: Set<string>): string {
	const output: string[] = [];
	for (const file of document.files) {
		const hunks = file.hunks.filter((hunk) => hunkIds.has(hunk.id));
		if (hunks.length === 0 && !fileIds.has(file.id)) continue;
		output.push(`### ${file.id} — ${file.label}`);
		if (file.hunks.length === 0) {
			output.push(file.raw.trimEnd());
			continue;
		}
		for (const line of file.header) output.push(line);
		for (const hunk of hunks) {
			output.push(`#### ${hunk.id}`);
			output.push(`@@ ... @@${hunk.headerSuffix}`);
			for (const line of hunk.lines) {
				output.push(`${line.lineNo}|${line.text}`);
				if (line.noNewlineMarker) output.push(` |${line.noNewlineMarker}`);
			}
		}
	}
	return output.join("\n");
}
