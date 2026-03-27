import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";

export const OPENAI_PARAMS_COMMAND = "openai-params";
export const OPENAI_PARAMS_CONFIG_BASENAME = "openai-params.json";
export const OPENAI_PARAMS_EVENT_CHANNEL = "pi:openai-params";
export const OPENAI_FAST_SERVICE_TIER = "priority";
export const DEFAULT_SUPPORTED_MODEL_KEYS = ["openai/gpt-5.4", "openai-codex/gpt-5.4"] as const;

export type Verbosity = "low" | "medium" | "high";

export interface OpenAIParamsState {
	fast: boolean;
	verbosity: Verbosity | undefined;
}

export interface OpenAIParamsEventPayload {
	source: typeof OPENAI_PARAMS_COMMAND;
	cwd: string;
	fast: boolean;
	verbosity: Verbosity | null;
}

export interface SupportedModel {
	provider: string;
	id: string;
}

export interface OpenAIParamsConfigFile {
	fast?: boolean;
	verbosity?: Verbosity | null;
	supportedModels?: string[];
}

export interface ResolvedOpenAIParamsConfig extends OpenAIParamsState {
	configPath: string;
	supportedModels: SupportedModel[];
}

type JsonObject = Record<string, unknown>;
type SupportedVerbosityApi = "openai-responses" | "openai-codex-responses" | "azure-openai-responses";
type ModelLike = Pick<Model<Api>, "provider" | "id" | "api">;

const DEFAULT_CONFIG_FILE: OpenAIParamsConfigFile = {
	fast: false,
	verbosity: null,
	supportedModels: [...DEFAULT_SUPPORTED_MODEL_KEYS],
};

const SUPPORTED_VERBOSITY_APIS = new Set<SupportedVerbosityApi>([
	"openai-responses",
	"openai-codex-responses",
	"azure-openai-responses",
]);

export function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeVerbosity(value: unknown): Verbosity | undefined {
	if (typeof value !== "string") {
		return undefined;
	}

	const normalized = value.trim().toLowerCase();
	if (normalized === "low" || normalized === "medium" || normalized === "high") {
		return normalized;
	}

	return undefined;
}

export function cycleVerbosity(current: Verbosity | undefined, direction: "forward" | "backward" = "forward"): Verbosity | undefined {
	const values: Array<Verbosity | undefined> = [undefined, "low", "medium", "high"];
	const currentIndex = values.indexOf(current);
	const safeIndex = currentIndex >= 0 ? currentIndex : 0;
	const offset = direction === "forward" ? 1 : -1;
	const nextIndex = (safeIndex + offset + values.length) % values.length;
	return values[nextIndex];
}

export function formatVerbosityLabel(verbosity: Verbosity | undefined): string {
	return verbosity ?? "default";
}

export function getConfigPaths(
	cwd: string,
	homeDir: string = homedir(),
): {
	projectConfigPath: string;
	globalConfigPath: string;
} {
	return {
		projectConfigPath: join(cwd, ".pi", "extensions", OPENAI_PARAMS_CONFIG_BASENAME),
		globalConfigPath: join(homeDir, ".pi", "agent", OPENAI_PARAMS_CONFIG_BASENAME),
	};
}

export function parseSupportedModelKey(value: string): SupportedModel | undefined {
	const trimmed = value.trim();
	if (!trimmed) {
		return undefined;
	}

	const slashIndex = trimmed.indexOf("/");
	if (slashIndex <= 0 || slashIndex >= trimmed.length - 1) {
		return undefined;
	}

	const provider = trimmed.slice(0, slashIndex).trim();
	const id = trimmed.slice(slashIndex + 1).trim();
	if (!provider || !id) {
		return undefined;
	}

	return { provider, id };
}

export function normalizeSupportedModelKeys(value: unknown): string[] | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value)) {
		return undefined;
	}

	const normalized: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string") {
			continue;
		}
		const parsed = parseSupportedModelKey(entry);
		if (!parsed) {
			continue;
		}
		normalized.push(`${parsed.provider}/${parsed.id}`);
	}
	return normalized;
}

export function parseSupportedModels(value: readonly string[]): SupportedModel[];
export function parseSupportedModels(value: unknown): SupportedModel[] | undefined;
export function parseSupportedModels(value: unknown): SupportedModel[] | undefined {
	const normalized = normalizeSupportedModelKeys(value);
	if (normalized === undefined) {
		return undefined;
	}

	return normalized
		.map((entry) => parseSupportedModelKey(entry))
		.filter((entry): entry is SupportedModel => entry !== undefined);
}

export function readConfigFile(filePath: string): OpenAIParamsConfigFile | null {
	if (!existsSync(filePath)) {
		return null;
	}

	try {
		const raw = readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw) as unknown;
		if (!isObject(parsed)) {
			return {};
		}

		const config: OpenAIParamsConfigFile = {};
		if (typeof parsed.fast === "boolean") {
			config.fast = parsed.fast;
		}
		if (parsed.verbosity === null) {
			config.verbosity = null;
		} else {
			const verbosity = normalizeVerbosity(parsed.verbosity);
			if (verbosity) {
				config.verbosity = verbosity;
			}
		}
		const supportedModels = normalizeSupportedModelKeys(parsed.supportedModels);
		if (supportedModels !== undefined) {
			config.supportedModels = supportedModels;
		}
		return config;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`[openai-params] Failed to read ${filePath}: ${message}`);
		return null;
	}
}

export function writeConfigFile(filePath: string, config: OpenAIParamsConfigFile): void {
	try {
		mkdirSync(dirname(filePath), { recursive: true });
		writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`[openai-params] Failed to write ${filePath}: ${message}`);
	}
}

export function ensureDefaultConfigFile(projectConfigPath: string, globalConfigPath: string): void {
	if (existsSync(projectConfigPath) || existsSync(globalConfigPath)) {
		return;
	}

	writeConfigFile(globalConfigPath, DEFAULT_CONFIG_FILE);
}

export function resolveConfig(cwd: string, homeDir: string = homedir()): ResolvedOpenAIParamsConfig {
	const { projectConfigPath, globalConfigPath } = getConfigPaths(cwd, homeDir);
	ensureDefaultConfigFile(projectConfigPath, globalConfigPath);

	const globalConfig = readConfigFile(globalConfigPath) ?? {};
	const projectConfig = readConfigFile(projectConfigPath) ?? {};
	const selectedConfigPath = existsSync(projectConfigPath) ? projectConfigPath : globalConfigPath;
	const merged = { ...globalConfig, ...projectConfig };
	const supportedModels =
		parseSupportedModels(merged.supportedModels) ?? parseSupportedModels(DEFAULT_SUPPORTED_MODEL_KEYS) ?? [];

	return {
		configPath: selectedConfigPath,
		fast: merged.fast ?? DEFAULT_CONFIG_FILE.fast ?? false,
		verbosity: normalizeVerbosity(merged.verbosity),
		supportedModels,
	};
}

export function toConfigFile(config: ResolvedOpenAIParamsConfig | OpenAIParamsState, supportedModels: SupportedModel[]): OpenAIParamsConfigFile {
	return {
		fast: config.fast,
		verbosity: config.verbosity ?? null,
		supportedModels: supportedModels.map((model) => `${model.provider}/${model.id}`),
	};
}

export function toOpenAIParamsEventPayload(cwd: string, config: ResolvedOpenAIParamsConfig | OpenAIParamsState): OpenAIParamsEventPayload {
	return {
		source: OPENAI_PARAMS_COMMAND,
		cwd,
		fast: config.fast,
		verbosity: config.verbosity ?? null,
	};
}

export function persistConfig(config: ResolvedOpenAIParamsConfig): void {
	writeConfigFile(config.configPath, toConfigFile(config, config.supportedModels));
}

export function getCurrentModelKey(model: Pick<Model<Api>, "provider" | "id"> | undefined): string | undefined {
	if (!model) {
		return undefined;
	}
	return `${model.provider}/${model.id}`;
}

export function supportsVerbosityControl(model: Pick<ModelLike, "api"> | undefined): boolean {
	if (!model) {
		return false;
	}

	return SUPPORTED_VERBOSITY_APIS.has(model.api as SupportedVerbosityApi);
}

export function isFastSupportedModel(
	model: Pick<ModelLike, "provider" | "id"> | undefined,
	supportedModels: SupportedModel[],
): boolean {
	if (!model) {
		return false;
	}

	return supportedModels.some((supported) => supported.provider === model.provider && supported.id === model.id);
}

export function applyFastServiceTier(payload: unknown): unknown {
	if (!isObject(payload)) {
		return payload;
	}

	return {
		...payload,
		service_tier: OPENAI_FAST_SERVICE_TIER,
	};
}

export function patchPayloadVerbosity(payload: unknown, verbosity: Verbosity): unknown {
	if (!isObject(payload)) {
		return payload;
	}

	const text = isObject(payload.text) ? payload.text : {};
	return {
		...payload,
		text: {
			...text,
			verbosity,
		},
	};
}

export function applyConfiguredParams(
	payload: unknown,
	model: ModelLike | undefined,
	config: ResolvedOpenAIParamsConfig | OpenAIParamsState,
	supportedModels: SupportedModel[],
): { payload: unknown; changed: boolean } {
	let nextPayload = payload;
	let changed = false;

	if (config.fast && isFastSupportedModel(model, supportedModels)) {
		nextPayload = applyFastServiceTier(nextPayload);
		changed = nextPayload !== payload || changed;
	}

	if (config.verbosity && supportsVerbosityControl(model)) {
		const patchedPayload = patchPayloadVerbosity(nextPayload, config.verbosity);
		changed = patchedPayload !== nextPayload || changed;
		nextPayload = patchedPayload;
	}

	return { payload: nextPayload, changed };
}

export const _test = {
	DEFAULT_CONFIG_FILE,
	SUPPORTED_VERBOSITY_APIS,
};
