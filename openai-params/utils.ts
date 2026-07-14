import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

export const OPENAI_PARAMS_COMMAND = "openai-params";
export const OPENAI_PARAMS_CONFIG_BASENAME = "openai-params.json";
export const OPENAI_PARAMS_EVENT_CHANNEL = "pi:openai-params";
export const OPENAI_FAST_SERVICE_TIER = "priority";

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

export interface OpenAIParamsConfigFile {
	fast?: boolean;
	verbosity?: Verbosity | null;
}

export interface ResolvedOpenAIParamsConfig extends OpenAIParamsState {
	configPath: string;
}

type JsonObject = Record<string, unknown>;
type SupportedFastProvider = "openai" | "openai-codex";
type SupportedFastApi = "openai-completions" | "openai-responses" | "openai-codex-responses";
type SupportedVerbosityApi = "openai-responses" | "openai-codex-responses" | "azure-openai-responses";
type ModelLike = Pick<Model<Api>, "provider" | "id" | "api">;

const DEFAULT_CONFIG_FILE: OpenAIParamsConfigFile = {
	fast: false,
	verbosity: null,
};

const SUPPORTED_FAST_PROVIDERS = new Set<SupportedFastProvider>(["openai", "openai-codex"]);

const SUPPORTED_FAST_APIS = new Set<SupportedFastApi>([
	"openai-completions",
	"openai-responses",
	"openai-codex-responses",
]);

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
		projectConfigPath: join(cwd, CONFIG_DIR_NAME, "extensions", OPENAI_PARAMS_CONFIG_BASENAME),
		globalConfigPath: join(homeDir, CONFIG_DIR_NAME, "agent", OPENAI_PARAMS_CONFIG_BASENAME),
	};
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

export function ensureDefaultConfigFile(
	projectConfigPath: string,
	globalConfigPath: string,
	options: { projectTrusted?: boolean } = {},
): void {
	if (options.projectTrusted !== false && existsSync(projectConfigPath)) {
		return;
	}
	if (existsSync(globalConfigPath)) {
		return;
	}

	writeConfigFile(globalConfigPath, DEFAULT_CONFIG_FILE);
}

export function resolveConfig(
	cwd: string,
	homeDir: string = homedir(),
	options: { projectTrusted?: boolean } = {},
): ResolvedOpenAIParamsConfig {
	const { projectConfigPath, globalConfigPath } = getConfigPaths(cwd, homeDir);
	const projectTrusted = options.projectTrusted !== false;
	ensureDefaultConfigFile(projectConfigPath, globalConfigPath, { projectTrusted });

	const globalConfig = readConfigFile(globalConfigPath) ?? {};
	const projectConfig = projectTrusted ? readConfigFile(projectConfigPath) ?? {} : {};
	const selectedConfigPath = projectTrusted && existsSync(projectConfigPath) ? projectConfigPath : globalConfigPath;
	const merged = { ...globalConfig, ...projectConfig };

	return {
		configPath: selectedConfigPath,
		fast: merged.fast ?? DEFAULT_CONFIG_FILE.fast ?? false,
		verbosity: normalizeVerbosity(merged.verbosity),
	};
}

export function toConfigFile(config: ResolvedOpenAIParamsConfig | OpenAIParamsState): OpenAIParamsConfigFile {
	return {
		fast: config.fast,
		verbosity: config.verbosity ?? null,
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
	writeConfigFile(config.configPath, toConfigFile(config));
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

export function supportsFastMode(model: ModelLike | undefined): boolean {
	if (!model) {
		return false;
	}

	return (
		SUPPORTED_FAST_PROVIDERS.has(model.provider as SupportedFastProvider) &&
		/^gpt-/i.test(model.id) &&
		SUPPORTED_FAST_APIS.has(model.api as SupportedFastApi)
	);
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
): { payload: unknown; changed: boolean } {
	let nextPayload = payload;
	let changed = false;

	if (config.fast && supportsFastMode(model)) {
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
	SUPPORTED_FAST_PROVIDERS,
	SUPPORTED_FAST_APIS,
	SUPPORTED_VERBOSITY_APIS,
};
