import { describe, expect, test } from "bun:test";
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
				verbosity: undefined,
			}),
		).toEqual({
			source: "openai-params",
			cwd: "/work",
			fast: true,
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
				verbosity: "medium",
				supportedModels: ["openai/gpt-5.4"],
			}),
		);
		writeFileSync(
			projectConfigPath,
			JSON.stringify({
				verbosity: "high",
				supportedModels: ["openai-codex/gpt-5.4"],
			}),
		);

		const resolved = resolveConfig(cwd, homeDir);
		expect(resolved.configPath).toBe(projectConfigPath);
		expect(resolved.fast).toBe(true);
		expect(resolved.verbosity).toBe("high");
		expect(resolved.supportedModels).toEqual([{ provider: "openai-codex", id: "gpt-5.4" }]);

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
		expect(readFileSync(globalConfigPath, "utf8")).toContain('"verbosity": null');

		rmSync(baseDir, { recursive: true, force: true });
	});
});

describe("applyConfiguredParams", () => {
	const config: ResolvedOpenAIParamsConfig = {
		configPath: "/tmp/openai-params.json",
		fast: true,
		verbosity: "low",
		supportedModels: [{ provider: "openai-codex", id: "gpt-5.4" }],
	};

	test("applies both priority service tier and text verbosity when supported", () => {
		const result = applyConfiguredParams(
			{ input: "hi" },
			{ provider: "openai-codex", id: "gpt-5.4", api: "openai-codex-responses" },
			config,
			config.supportedModels,
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

	test("leaves unsupported models unchanged", () => {
		const result = applyConfiguredParams(
			{ input: "hi" },
			{ provider: "anthropic", id: "claude", api: "anthropic-messages" },
			config,
			config.supportedModels,
		);

		expect(result.changed).toBe(false);
		expect(result.payload).toEqual({ input: "hi" });
	});
});
