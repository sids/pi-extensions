export const INPUT_NEEDED_MARKER = ":input_needed:";

export const INPUT_NEEDED_INSTRUCTION = `<herdr_integration>
When you cannot continue until you receive a response, end your final response with ${INPUT_NEEDED_MARKER} on a line by itself.
Use the marker only when a response is required to continue. Do not use it for optional questions, suggestions, or completed work.
</herdr_integration>`;

export type WaitingForUserInputEvent = {
	source: string;
	id: string;
	waiting: boolean;
};

function readNonEmptyString(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed ? trimmed : null;
}

export function isHerdrSession(env: Record<string, string | undefined> = process.env): boolean {
	return (
		env.HERDR_ENV === "1" &&
		readNonEmptyString(env.HERDR_SOCKET_PATH) !== null &&
		readNonEmptyString(env.HERDR_PANE_ID) !== null
	);
}

export function appendInputNeededInstruction(systemPrompt: string): string {
	if (systemPrompt.includes(INPUT_NEEDED_INSTRUCTION)) {
		return systemPrompt;
	}
	return systemPrompt ? `${systemPrompt}\n\n${INPUT_NEEDED_INSTRUCTION}` : INPUT_NEEDED_INSTRUCTION;
}

export function hasInputNeededMarker(text: string): boolean {
	const lines = text.trimEnd().split(/\r?\n/);
	return lines.at(-1)?.trim() === INPUT_NEEDED_MARKER;
}

export function stripInputNeededMarker(text: string, isStreaming = false): string {
	const lines = text.trimEnd().split(/\r?\n/);
	const trailingLine = lines.at(-1)?.trim() ?? "";
	const isCompleteMarker = trailingLine === INPUT_NEEDED_MARKER;
	const isStreamingPrefix =
		isStreaming && trailingLine.length > 0 && INPUT_NEEDED_MARKER.startsWith(trailingLine);
	if (!isCompleteMarker && !isStreamingPrefix) {
		return text;
	}

	lines.pop();
	return lines.join("\n").trimEnd();
}

export function parseWaitingForUserInputEvent(data: unknown): WaitingForUserInputEvent | null {
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		return null;
	}

	const value = data as Record<string, unknown>;
	const source = readNonEmptyString(value.source);
	const id = readNonEmptyString(value.id);
	if (!source || !id || typeof value.waiting !== "boolean") {
		return null;
	}

	return { source, id, waiting: value.waiting };
}
