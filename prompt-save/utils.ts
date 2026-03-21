import { randomUUID } from "node:crypto";

export const STATE_ENTRY_TYPE = "prompt-save:state";
export const MUTATION_ENTRY_TYPE = "prompt-save:mutation";
export const STATE_VERSION = 1;

export interface SavedPromptItem {
	id: string;
	text: string;
	createdAt: number;
}

export interface PromptSaveState {
	version: number;
	items: SavedPromptItem[];
}

export interface AddPromptSaveMutation {
	version: number;
	action: "add";
	item: SavedPromptItem;
}

export interface DeletePromptSaveMutation {
	version: number;
	action: "delete";
	itemId: string;
}

export type PromptSaveMutation = AddPromptSaveMutation | DeletePromptSaveMutation;

export function createEmptyPromptSaveState(): PromptSaveState {
	return {
		version: STATE_VERSION,
		items: [],
	};
}

export function clonePromptSaveState(state: PromptSaveState): PromptSaveState {
	return {
		version: state.version,
		items: state.items.map((item) => ({ ...item })),
	};
}

export function isSavedPromptItem(value: unknown): value is SavedPromptItem {
	if (!value || typeof value !== "object") {
		return false;
	}

	const item = value as Partial<SavedPromptItem>;
	return (
		typeof item.id === "string" &&
		typeof item.text === "string" &&
		typeof item.createdAt === "number" &&
		Number.isFinite(item.createdAt)
	);
}

export function isPromptSaveState(value: unknown): value is PromptSaveState {
	if (!value || typeof value !== "object") {
		return false;
	}

	const state = value as Partial<PromptSaveState>;
	return state.version === STATE_VERSION && Array.isArray(state.items) && state.items.every(isSavedPromptItem);
}

export function isPromptSaveMutation(value: unknown): value is PromptSaveMutation {
	if (!value || typeof value !== "object") {
		return false;
	}

	const mutation = value as Partial<PromptSaveMutation>;
	if (mutation.version !== STATE_VERSION) {
		return false;
	}

	if (mutation.action === "add") {
		return isSavedPromptItem(mutation.item);
	}

	if (mutation.action === "delete") {
		return typeof mutation.itemId === "string";
	}

	return false;
}

export function applyPromptSaveMutation(state: PromptSaveState, mutation: PromptSaveMutation): PromptSaveState {
	if (mutation.action === "add") {
		return addSavedPrompt(state, mutation.item);
	}

	return deleteSavedPrompt(state, mutation.itemId);
}

export function getLatestPromptSaveStateFromEntries(entries: Array<{ type?: string; customType?: string; data?: unknown }>): PromptSaveState {
	let state = createEmptyPromptSaveState();

	for (const entry of entries) {
		if (entry.type !== "custom") {
			continue;
		}

		if (entry.customType === STATE_ENTRY_TYPE && isPromptSaveState(entry.data)) {
			state = clonePromptSaveState(entry.data);
			continue;
		}

		if (entry.customType === MUTATION_ENTRY_TYPE && isPromptSaveMutation(entry.data)) {
			state = applyPromptSaveMutation(state, entry.data);
		}
	}

	return state;
}

export function hasMeaningfulText(text: string): boolean {
	return text.trim().length > 0;
}

export function appendPromptToEditor(editorText: string, promptText: string): string {
	if (!hasMeaningfulText(editorText)) {
		return promptText;
	}

	const normalizedEditorText = editorText.replace(/(?:\r?\n)+$/u, "");
	const normalizedPromptText = promptText.replace(/^(?:\r?\n)+/u, "");
	return `${normalizedEditorText}\n${normalizedPromptText}`;
}

export function createSavedPromptItem(
	text: string,
	options?: {
		id?: string;
		createdAt?: number;
	},
): SavedPromptItem {
	return {
		id: options?.id ?? randomUUID(),
		text,
		createdAt: options?.createdAt ?? Date.now(),
	};
}

export function addSavedPrompt(state: PromptSaveState, item: SavedPromptItem): PromptSaveState {
	return {
		version: STATE_VERSION,
		items: [...state.items.map((existingItem) => ({ ...existingItem })), { ...item }],
	};
}

export function deleteSavedPrompt(state: PromptSaveState, itemId: string): PromptSaveState {
	return {
		version: STATE_VERSION,
		items: state.items.filter((item) => item.id !== itemId).map((item) => ({ ...item })),
	};
}

export function createAddPromptSaveMutation(item: SavedPromptItem): AddPromptSaveMutation {
	return {
		version: STATE_VERSION,
		action: "add",
		item: { ...item },
	};
}

export function createDeletePromptSaveMutation(itemId: string): DeletePromptSaveMutation {
	return {
		version: STATE_VERSION,
		action: "delete",
		itemId,
	};
}

function collapseWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

export function buildPromptPreview(text: string): { label: string; description?: string } {
	const normalized = text.replace(/\r\n/g, "\n");
	const lines = normalized.split("\n");
	const collapsedLines = lines.map(collapseWhitespace).filter((line) => line.length > 0);
	const label = collapsedLines[0] ?? "(blank prompt)";

	return {
		label,
		description: collapsedLines.length > 1 || lines.length > 1 ? "…" : undefined,
	};
}
