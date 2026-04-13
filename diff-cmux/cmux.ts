import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const CMUX_COMMAND_TIMEOUT_MS = 1500;

type ExecResult = {
	stdout: string;
	stderr: string;
	code: number;
	killed?: boolean;
};

export type CmuxCallerContext = {
	workspaceId: string;
	callerPaneRef: string | null;
};

function readNonEmptyString(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseFieldMap(raw: string): Map<string, string> {
	const fields = new Map<string, string>();
	const matches = Array.from(raw.matchAll(/(^|\s)([A-Za-z][A-Za-z0-9_.-]*)=/g));
	for (let index = 0; index < matches.length; index += 1) {
		const match = matches[index];
		const fieldName = match[2];
		if (!fieldName) {
			continue;
		}
		const valueStart = match.index! + match[0].length;
		const valueEnd = index + 1 < matches.length ? matches[index + 1]!.index! : raw.length;
		fields.set(fieldName, raw.slice(valueStart, valueEnd).trim());
	}
	return fields;
}

function getJsonPath(value: unknown, path: string[]): string | null {
	let current: unknown = value;
	for (const key of path) {
		if (!isRecord(current)) {
			return null;
		}
		current = current[key];
	}
	return readNonEmptyString(current);
}

export function getCmuxWorkspaceId(env: Record<string, string | undefined> = process.env): string | null {
	return readNonEmptyString(env.CMUX_WORKSPACE_ID);
}

export function parseCmuxIdentify(raw: string, env: Record<string, string | undefined> = {}): CmuxCallerContext | null {
	const workspaceFromEnv = getCmuxWorkspaceId(env);
	const trimmed = raw.trim();
	if (!trimmed) {
		return workspaceFromEnv
			? {
					workspaceId: workspaceFromEnv,
					callerPaneRef: null,
				}
			: null;
	}

	try {
		const parsed = JSON.parse(trimmed);
		const workspaceId =
			workspaceFromEnv ??
			getJsonPath(parsed, ["workspace", "id"]) ??
			getJsonPath(parsed, ["workspace_id"]) ??
			getJsonPath(parsed, ["caller", "workspace_id"]);
		const callerPaneRef =
			getJsonPath(parsed, ["caller", "pane_ref"]) ??
			getJsonPath(parsed, ["pane_ref"]) ??
			getJsonPath(parsed, ["pane", "ref"]);
		if (!workspaceId) {
			return null;
		}
		return {
			workspaceId,
			callerPaneRef,
		};
	} catch {
		const fields = parseFieldMap(trimmed);
		const workspaceId = workspaceFromEnv ?? fields.get("workspace.id") ?? fields.get("workspace_id") ?? null;
		const callerPaneRef = fields.get("caller.pane_ref") ?? fields.get("pane_ref") ?? null;
		if (!workspaceId) {
			return null;
		}
		return {
			workspaceId,
			callerPaneRef,
		};
	}
}

export function buildNewPaneArgs(workspaceId: string, url: string): string[] {
	return ["new-pane", "--type", "browser", "--direction", "right", "--workspace", workspaceId, "--url", url];
}

export function buildNewSurfaceArgs(workspaceId: string, paneRef: string, url: string): string[] {
	return ["new-surface", "--type", "browser", "--workspace", workspaceId, "--pane", paneRef, "--url", url];
}

async function execCmux(pi: ExtensionAPI, args: string[], cwd: string): Promise<ExecResult> {
	return await pi.exec("cmux", args, {
		cwd,
		timeout: CMUX_COMMAND_TIMEOUT_MS,
	});
}

export async function resolveCmuxCallerContext(
	pi: ExtensionAPI,
	cwd: string,
	env: Record<string, string | undefined> = process.env,
): Promise<CmuxCallerContext | null> {
	try {
		const result = await execCmux(pi, ["identify"], cwd);
		if (result.code !== 0) {
			return null;
		}
		return parseCmuxIdentify(result.stdout, env);
	} catch {
		return null;
	}
}

export async function openCmuxPane(pi: ExtensionAPI, cwd: string, workspaceId: string, url: string): Promise<ExecResult> {
	return await execCmux(pi, buildNewPaneArgs(workspaceId, url), cwd);
}

export async function openCmuxSurface(
	pi: ExtensionAPI,
	cwd: string,
	workspaceId: string,
	paneRef: string,
	url: string,
): Promise<ExecResult> {
	return await execCmux(pi, buildNewSurfaceArgs(workspaceId, paneRef, url), cwd);
}
