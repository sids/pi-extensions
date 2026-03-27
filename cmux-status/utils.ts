export type CmuxStatusLabel = "Ready" | "Working" | "Waiting" | "Error";

const CMUX_STATUS_PRIORITY: Record<CmuxStatusLabel, number> = {
	Ready: 0,
	Working: 1,
	Waiting: 2,
	Error: 3,
};

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

export function getCmuxWorkspaceId(env: Record<string, string | undefined> = process.env): string | null {
	return readNonEmptyString(env.CMUX_WORKSPACE_ID);
}

export function getCmuxStatusPriority(status: CmuxStatusLabel): number {
	return CMUX_STATUS_PRIORITY[status];
}

export function formatCmuxStatusKey(sessionName: string | undefined | null): string {
	const trimmedName = sessionName?.trim();
	return trimmedName ? `pi-cmux-status:${trimmedName}` : "pi-cmux-status";
}

export function formatCmuxStatusText(sessionName: string | undefined | null, status: CmuxStatusLabel): string {
	const trimmedName = sessionName?.trim();
	return trimmedName ? `π ${trimmedName}: ${status}` : `π - ${status}`;
}

export function parseManagedCmuxStatusText(text: string | undefined | null): { status: CmuxStatusLabel } | null {
	const value = readNonEmptyString(text);
	if (!value || !value.startsWith("π ")) {
		return null;
	}

	const statuses: CmuxStatusLabel[] = ["Ready", "Working", "Waiting", "Error"];
	for (const status of statuses) {
		if (value === `π - ${status}` || value.endsWith(`: ${status}`)) {
			return { status };
		}
	}

	return null;
}

export function shouldOverwriteCmuxStatus(
	currentText: string | null,
	lastWrittenText: string | null,
	nextText: string | null,
): boolean {
	if (nextText === null) {
		return currentText !== null && currentText === lastWrittenText;
	}
	if (currentText === nextText) {
		return false;
	}
	if (currentText === null) {
		return true;
	}
	if (currentText === lastWrittenText) {
		return true;
	}

	const current = parseManagedCmuxStatusText(currentText);
	const next = parseManagedCmuxStatusText(nextText);
	if (!current || !next) {
		return false;
	}

	return getCmuxStatusPriority(next.status) > getCmuxStatusPriority(current.status);
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
		return new Map();
	}
}
