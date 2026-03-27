export type CmuxStatusLabel = "Ready" | "Working" | "Waiting" | "Error";

export type CmuxStatusPresentation = {
	status: CmuxStatusLabel;
	text: string;
	icon: string | null;
	color: string | null;
};

const CMUX_STATUS_PRIORITY: Record<CmuxStatusLabel, number> = {
	Ready: 0,
	Working: 1,
	Waiting: 2,
	Error: 3,
};

const READY_STATUS_ICON = "checkmark";
const WORKING_STATUS_PREFIXES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const WAITING_STATUS_ICON = "hourglass";
const ERROR_STATUS_ICON = "exclamationmark.triangle.fill";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readNonEmptyString(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed ? trimmed : null;
}

function getCmuxStatusItems(value: unknown): unknown[] {
	if (Array.isArray(value)) {
		return value;
	}
	if (!isRecord(value)) {
		return [];
	}

	for (const key of ["statuses", "status", "entries", "items"] as const) {
		if (Array.isArray(value[key])) {
			return value[key];
		}
	}

	if (isRecord(value.result)) {
		for (const key of ["statuses", "status", "entries", "items"] as const) {
			if (Array.isArray(value.result[key])) {
				return value.result[key];
			}
		}
	}

	return [];
}

function parseCmuxStatusFields(line: string): Map<string, string> {
	const fields = new Map<string, string>();
	const matches = Array.from(line.matchAll(/(^|\s)([A-Za-z][A-Za-z0-9_-]*)=/g));
	for (let index = 0; index < matches.length; index += 1) {
		const match = matches[index];
		const fieldName = match[2];
		if (!fieldName) {
			continue;
		}
		const valueStart = match.index! + match[0].length;
		const valueEnd = index + 1 < matches.length ? matches[index + 1].index! : line.length;
		const value = line.slice(valueStart, valueEnd).trim();
		fields.set(fieldName, value);
	}
	return fields;
}

function stripTrailingCmuxMetadata(value: string): string {
	let remaining = value.trim();
	while (true) {
		const match = remaining.match(/^(.*)\s+(icon|color)=[^\s]+$/);
		if (!match) {
			return remaining;
		}
		remaining = match[1]?.trim() ?? remaining;
	}
}

function parseCmuxStatusTextLines(raw: string): Map<string, string> {
	const entries = new Map<string, string>();
	for (const line of raw.split(/\r?\n/)) {
		const trimmedLine = line.trim();
		if (!trimmedLine) {
			continue;
		}

		const structuredFields = parseCmuxStatusFields(trimmedLine);
		const structuredKey = readNonEmptyString(structuredFields.get("key"));
		if (structuredKey) {
			entries.set(structuredKey, structuredFields.get("value")?.trim() ?? "");
			continue;
		}

		const separatorIndex = trimmedLine.indexOf("=");
		if (separatorIndex <= 0) {
			continue;
		}

		const key = readNonEmptyString(trimmedLine.slice(0, separatorIndex));
		if (!key) {
			continue;
		}

		entries.set(key, stripTrailingCmuxMetadata(trimmedLine.slice(separatorIndex + 1)));
	}
	return entries;
}

export function getCmuxWorkspaceId(env: Record<string, string | undefined> = process.env): string | null {
	return readNonEmptyString(env.CMUX_WORKSPACE_ID);
}

export function getCmuxStatusOwnerId(env: Record<string, string | undefined> = process.env): string | null {
	const surfaceId = readNonEmptyString(env.CMUX_SURFACE_ID);
	const panelId = readNonEmptyString(env.CMUX_PANEL_ID);
	if (surfaceId && panelId) {
		return `surface:${surfaceId}:panel:${panelId}`;
	}
	if (surfaceId) {
		return `surface:${surfaceId}`;
	}
	if (panelId) {
		return `panel:${panelId}`;
	}
	return null;
}

export function formatCmuxStatusKey(ownerId?: string | null): string {
	const trimmedOwnerId = ownerId?.trim();
	return trimmedOwnerId ? `pi-cmux-status:${trimmedOwnerId}` : "pi-cmux-status";
}

export function formatCmuxStatusText(sessionName: string | undefined | null, status: CmuxStatusLabel): string {
	const trimmedName = sessionName?.trim();
	return trimmedName ? `π ${trimmedName}: ${status}` : `π - ${status}`;
}

export function getCmuxStatusPresentation(
	sessionName: string | undefined | null,
	status: CmuxStatusLabel,
	animationFrame = 0,
): CmuxStatusPresentation {
	const text = formatCmuxStatusText(sessionName, status);
	if (status === "Ready") {
		return { status, text, icon: READY_STATUS_ICON, color: null };
	}
	if (status === "Working") {
		const prefix =
			WORKING_STATUS_PREFIXES[
				((animationFrame % WORKING_STATUS_PREFIXES.length) + WORKING_STATUS_PREFIXES.length) %
					WORKING_STATUS_PREFIXES.length
			];
		return { status, text: `${prefix} ${text}`, icon: null, color: null };
	}
	if (status === "Waiting") {
		return { status, text, icon: WAITING_STATUS_ICON, color: null };
	}
	if (status === "Error") {
		return { status, text, icon: ERROR_STATUS_ICON, color: null };
	}
	return { status, text, icon: null, color: null };
}

export function areCmuxStatusPresentationsEqual(
	left: CmuxStatusPresentation | null,
	right: CmuxStatusPresentation | null,
): boolean {
	return (
		left?.status === right?.status &&
		left?.text === right?.text &&
		left?.icon === right?.icon &&
		left?.color === right?.color
	);
}

export function parseCmuxStatusList(raw: string): Map<string, string> {
	const trimmed = raw.trim();
	if (!trimmed) {
		return new Map();
	}

	try {
		const parsed = JSON.parse(trimmed);
		const entries = new Map<string, string>();
		for (const item of getCmuxStatusItems(parsed)) {
			if (!isRecord(item)) {
				continue;
			}
			const key = readNonEmptyString(item.key) ?? readNonEmptyString(item.id) ?? readNonEmptyString(item.name);
			if (!key) {
				continue;
			}
			const value =
				readNonEmptyString(item.value) ??
				readNonEmptyString(item.text) ??
				readNonEmptyString(item.label) ??
				readNonEmptyString(item.statusText) ??
				"";
			entries.set(key, value);
		}
		return entries;
	} catch {
		return parseCmuxStatusTextLines(trimmed);
	}
}
