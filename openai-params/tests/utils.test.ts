import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	applyConfiguredParams,
	cycleVerbosity,
	formatVerbosityLabel,
	getConfigPaths,
	patchPayloadVerbosity,
	resolveConfig,
	toOpenAIParamsEventPayload,
	type ResolvedOpenAIParamsConfig,
} from "../utils";

describe("cycleVerbosity", () => {
	test("cycles forward through unset and explicit levels", () => {
		expect(cycleVerbosity(undefined)).toBe("low");
		expect(cycleVerbosity("low")).toBe("medium");
		expect(cycleVerbosity("medium")).toBe("high");
		expect(cycleVerbosity("high")).toBeUndefined();
	});

	test("cycles backward through explicit levels and unset", () => {
		expect(cycleVerbosity(undefined, "backward")).toBe("high");
		expect(cycleVerbosity("high", "backward")).toBe("medium");
		expect(cycleVerbosity("medium", "backward")).toBe("low");
		expect(cycleVerbosity("low", "backward")).toBeUndefined();
	});
});

describe("formatVerbosityLabel", () => {
	test("renders unset verbosity as default", () => {
		expect(formatVerbosityLabel(undefined)).toBe("default");
		expect(formatVerbosityLabel("high")).toBe("high");
	});
});

describe("patchPayloadVerbosity", () => {
	test("preserves existing text fields", () => {
		expect(
			patchPayloadVerbosity(
				{
					input: "hello",
					text: {
						format: { type: "text" },
					},
				},
				"low",
			),
		).toEqual({
			input: "hello",
			text: {
				format: { type: "text" },
				verbosity: "low",
			},
		});
	});
});

describe("toOpenAIParamsEventPayload", () => {
	test("serializes unset verbosity as null", () => {
		expect(
			toOpenAIParamsEventPayload("/work", {
				fast: true,
				longCache: true,
				verbosity: undefined,
			}),
		).toEqual({
			source: "openai-params",
			cwd: "/work",
			fast: true,
			longCache: true,
			verbosity: null,
		});
	});
});

describe("resolveConfig", () => {
	test("merges project config over global config", () => {
		const baseDir = mkdtempSync(join(tmpdir(), "openai-params-"));
		const cwd = join(baseDir, "repo");
		const homeDir = join(baseDir, "home");
		const { projectConfigPath, globalConfigPath } = getConfigPaths(cwd, homeDir);

		mkdirSync(dirname(globalConfigPath), { recursive: true });
		mkdirSync(dirname(projectConfigPath), { recursive: true });
		writeFileSync(
			globalConfigPath,
			JSON.stringify({
				fast: true,
				longCache: true,
				verbosity: "medium",
			}),
		);
		writeFileSync(
			projectConfigPath,
			JSON.stringify({
				verbosity: "high",
			}),
		);

		const resolved = resolveConfig(cwd, homeDir);
		expect(resolved.configPath).toBe(projectConfigPath);
		expect(resolved.fast).toBe(true);
		expect(resolved.longCache).toBe(true);
		expect(resolved.verbosity).toBe("high");

		rmSync(baseDir, { recursive: true, force: true });
	});

	test("creates a default global config when none exists", () => {
		const baseDir = mkdtempSync(join(tmpdir(), "openai-params-"));
		const cwd = join(baseDir, "repo");
		const homeDir = join(baseDir, "home");
		const { globalConfigPath } = getConfigPaths(cwd, homeDir);

		const resolved = resolveConfig(cwd, homeDir);
		expect(resolved.configPath).toBe(globalConfigPath);
		expect(readFileSync(globalConfigPath, "utf8")).toContain('"fast": false');
		expect(readFileSync(globalConfigPath, "utf8")).toContain('"longCache": false');
		expect(readFileSync(globalConfigPath, "utf8")).toContain('"verbosity": null');

		rmSync(baseDir, { recursive: true, force: true });
	});

	test("ignores project config when the project is not trusted", () => {
		const baseDir = mkdtempSync(join(tmpdir(), "openai-params-"));
		const cwd = join(baseDir, "repo");
		const homeDir = join(baseDir, "home");
		const { projectConfigPath, globalConfigPath } = getConfigPaths(cwd, homeDir);

		mkdirSync(dirname(projectConfigPath), { recursive: true });
		writeFileSync(
			projectConfigPath,
			JSON.stringify({
				fast: true,
				longCache: true,
				verbosity: "high",
			}),
		);

		const resolved = resolveConfig(cwd, homeDir, { projectTrusted: false });
		expect(resolved.configPath).toBe(globalConfigPath);
		expect(resolved.fast).toBe(false);
		expect(resolved.longCache).toBe(false);
		expect(resolved.verbosity).toBeUndefined();
		expect(readFileSync(globalConfigPath, "utf8")).toContain('"fast": false');

		rmSync(baseDir, { recursive: true, force: true });
	});
});

describe("applyConfiguredParams", () => {
	const config: ResolvedOpenAIParamsConfig = {
		configPath: "/tmp/openai-params.json",
		fast: true,
		longCache: true,
		verbosity: "low",
	};

	test("applies both priority service tier and text verbosity to GPT models on Responses APIs", () => {
		const result = applyConfiguredParams(
			{ input: "hi" },
			{ provider: "openai-codex", id: "gpt-5.6-luna", api: "openai-codex-responses" },
			config,
		);

		expect(result.changed).toBe(true);
		expect(result.payload).toEqual({
			input: "hi",
			service_tier: "priority",
			text: {
				verbosity: "low",
			},
		});
	});

	test("applies priority service tier to GPT models on Chat Completions APIs", () => {
		const result = applyConfiguredParams(
			{ messages: [] },
			{ provider: "openai", id: "gpt-4o", api: "openai-completions" },
			{ ...config, verbosity: undefined },
		);

		expect(result.changed).toBe(true);
		expect(result.payload).toEqual({
			messages: [],
			service_tier: "priority",
			prompt_cache_retention: "24h",
		});
	});

	test("applies long cache only to official OpenAI API models", () => {
		const enabled = applyConfiguredParams(
			{ input: "hi", prompt_cache_key: "session-1" },
			{ provider: "openai", id: "gpt-5.4", api: "openai-responses" },
			{ ...config, fast: false, verbosity: undefined },
		);
		expect(enabled.longCacheApplied).toBe(true);
		expect(enabled.payload).toEqual({
			input: "hi",
			prompt_cache_key: "session-1",
			prompt_cache_retention: "24h",
		});

		const codex = applyConfiguredParams(
			{ input: "hi" },
			{ provider: "openai-codex", id: "gpt-5.4", api: "openai-codex-responses" },
			{ ...config, fast: false, verbosity: undefined },
		);
		expect(codex.changed).toBe(false);
		expect(codex.longCacheApplied).toBe(false);
		expect(codex.payload).toEqual({ input: "hi" });
	});

	test("leaves cache retention unchanged when the toggle is off", () => {
		const result = applyConfiguredParams(
			{ input: "hi" },
			{ provider: "openai", id: "gpt-5.4", api: "openai-responses" },
			{ ...config, fast: false, longCache: false, verbosity: undefined },
		);

		expect(result.changed).toBe(false);
		expect(result.longCacheApplied).toBe(false);
		expect(result.payload).toEqual({ input: "hi" });
	});

	test("does not apply fast mode to non-GPT models", () => {
		const result = applyConfiguredParams(
			{ input: "hi" },
			{ provider: "anthropic", id: "claude", api: "anthropic-messages" },
			config,
		);

		expect(result.changed).toBe(false);
		expect(result.payload).toEqual({ input: "hi" });
	});

	test("does not apply fast mode to GitHub Copilot GPT models that share an OpenAI API serializer", () => {
		const result = applyConfiguredParams(
			{ input: "hi" },
			{ provider: "github-copilot", id: "gpt-5.4-mini", api: "openai-responses" },
			{ ...config, verbosity: undefined },
		);

		expect(result.changed).toBe(false);
		expect(result.payload).toEqual({ input: "hi" });
	});

	test("does not apply fast mode to custom GPT routes that share an OpenAI API serializer", () => {
		const result = applyConfiguredParams(
			{ messages: [] },
			{ provider: "local-proxy", id: "gpt-local", api: "openai-completions" },
			{ ...config, verbosity: undefined },
		);

		expect(result.changed).toBe(false);
		expect(result.payload).toEqual({ messages: [] });
	});
});
