import { randomBytes } from "node:crypto";
import path from "node:path";
import type { PlanModeState } from "./types";

export const PLAN_MODE_STATE_VERSION = 1;

export type { PlanModeState };

export const PLAN_MODE_START_OPTIONS = ["Empty branch", "Current branch"] as const;
export const PLAN_MODE_END_OPTIONS = ["Exit", "Exit & stay in current branch"] as const;

export function createInactivePlanModeState(): PlanModeState {
	return {
		version: PLAN_MODE_STATE_VERSION,
		active: false,
	};
}

export function createPlanModeActivationId(): string {
	return `plan-${randomBytes(4).toString("hex")}`;
}

export function isPlanModeState(value: unknown): value is PlanModeState {
	if (!value || typeof value !== "object") {
		return false;
	}

	const state = value as Partial<PlanModeState>;
	return state.version === PLAN_MODE_STATE_VERSION && typeof state.active === "boolean";
}

export function resolvePlanFilePath(cwd: string, filePath: string): string | null {
	const trimmed = filePath.trim();
	if (!trimmed) {
		return null;
	}
	return path.resolve(cwd, trimmed);
}

export function findDuplicateId(ids: string[]): string | null {
	const seen = new Set<string>();
	for (const id of ids) {
		if (seen.has(id)) {
			return id;
		}
		seen.add(id);
	}
	return null;
}

export function buildImplementationPrefill(planPath?: string): string {
	if (planPath) {
		return `Plan file: ${planPath}\nImplement the approved plan in this file. Keep changes focused, update tests, and summarize what was implemented.`;
	}
	return "Implement the approved plan step by step. Keep changes focused, update tests, and summarize what was implemented.";
}
