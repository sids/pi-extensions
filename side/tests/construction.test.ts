import { describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	createCalls: [] as any[],
	loaderOptions: [] as any[],
	settings: [] as any[],
	managers: [] as any[],
	runtimes: [] as any[],
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
	class Loader {
		constructor(options: any) {
			mocks.loaderOptions.push(options);
		}
		async reload() {}
		getExtensions() { return { extensions: [], errors: [], runtime: {} }; }
		getSkills() { return { skills: [], diagnostics: [] }; }
		getPrompts() { return { prompts: [], diagnostics: [] }; }
		getThemes() { return { themes: [], diagnostics: [] }; }
		getAgentsFiles() { return { agentsFiles: [] }; }
		getSystemPrompt() { return undefined; }
		getAppendSystemPrompt() { return []; }
		extendResources() {}
	}
	return {
		...actual,
		DefaultResourceLoader: Loader,
		getAgentDir: () => "/tmp/agent",
		SettingsManager: {
			inMemory: (value: any) => {
				const settings = { value };
				mocks.settings.push(settings);
				return settings;
			},
		},
		SessionManager: {
			inMemory: (cwd: string, options: any) => {
				const manager = {
					cwd,
					options,
					messages: [] as any[],
					appendCustomMessageEntry(...args: any[]) { this.messages.push(args); },
				};
				mocks.managers.push(manager);
				return manager;
			},
		},
		ModelRuntime: {
			create: async (options: any) => {
				const runtime: any = {
					options,
					providers: [] as any[],
					providerConfigs: [] as any[],
					runtimeKeys: [] as any[],
					registerNativeProvider(provider: any) { this.providers.push(provider); },
					registerProvider(providerId: string, config: any) { this.providerConfigs.push([providerId, config]); },
					refresh: vi.fn(async () => undefined),
				};
				runtime.setRuntimeApiKey = vi.fn(async (...args: any[]) => { runtime.runtimeKeys.push(args); });
				mocks.runtimes.push(runtime);
				return runtime;
			},
		},
		createAgentSession: async (options: any) => {
			mocks.createCalls.push(options);
			return {
				session: {
					isIdle: true,
					isStreaming: false,
					model: options.model,
					thinkingLevel: options.thinkingLevel,
					modelRuntime: options.modelRuntime,
					scopedModels: options.scopedModels,
					subscribe: () => () => undefined,
					dispose: vi.fn(),
				},
			};
		},
	};
});

import { createSideSession } from "../side-session";

describe("createSideSession", () => {
	test("creates an in-memory read-only child with summary-only parent context", async () => {
		mocks.createCalls.length = 0;
		mocks.loaderOptions.length = 0;
		mocks.settings.length = 0;
		mocks.managers.length = 0;
		mocks.runtimes.length = 0;
		const parentTools = [{ name: "main_session_status" }] as any;
		const model = { provider: "test", id: "model" } as any;
		const nativeProvider = { id: "custom-native", name: "Custom native" };
		const providerConfig = { name: "Custom config", baseUrl: "https://example.test" };
		const registry = {
			getAll: () => [model],
			getAvailable: () => [model],
			getRegisteredProviderIds: () => ["custom-native", "custom-config"],
			getRegisteredNativeProvider: (providerId: string) =>
				providerId === "custom-native" ? nativeProvider : undefined,
			getRegisteredProviderConfig: (providerId: string) =>
				providerId === "custom-config" ? providerConfig : undefined,
			getProviderAuthStatus: (providerId: string) => ({
				configured: true,
				source: providerId === "test" ? "runtime" : "environment",
			}),
			getProviderAuth: async (providerId: string) =>
				providerId === "test" ? { auth: { apiKey: "runtime-key" } } : undefined,
		};
		const parentView = { dispose: vi.fn() } as any;
		const controller = await createSideSession({
			ctx: {
				cwd: "/tmp/project",
				modelRegistry: registry,
				scopedModels: [{ model, thinkingLevel: "high" }],
			} as any,
			snapshot: {
				sessionId: "parent",
				sessionFile: "/tmp/parent.jsonl",
				leafId: "leaf",
				entries: [],
				entryIds: new Set(),
				model,
				systemPrompt: "parent raw context must not be copied",
				thinkingLevel: "high",
			},
			parentView,
			parentTools,
			mainThinkingLevel: "high",
		});

		expect(mocks.loaderOptions[0]).toMatchObject({
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
		});
		expect(mocks.loaderOptions[0].noContextFiles).toBeUndefined();
		expect(mocks.createCalls[0]).toMatchObject({
			cwd: "/tmp/project",
			model,
			thinkingLevel: "medium",
			tools: ["read", "grep", "find", "ls", "main_session_status"],
			customTools: parentTools,
			modelRuntime: mocks.runtimes[0],
			scopedModels: [{ model, thinkingLevel: "high" }],
		});
		expect(mocks.runtimes[0].providers).toEqual([nativeProvider]);
		expect(mocks.runtimes[0].providerConfigs).toEqual([["custom-config", providerConfig]]);
		expect(mocks.runtimes[0].runtimeKeys).toEqual([["test", "runtime-key", { allowNetwork: false }]]);
		expect(mocks.runtimes[0].refresh).toHaveBeenCalledTimes(1);
		expect(mocks.runtimes[0].refresh).toHaveBeenCalledWith({ allowNetwork: false });
		expect(mocks.managers[0].options).toEqual({ parentSession: "/tmp/parent.jsonl" });
		const hiddenContext = mocks.managers[0].messages[0];
		expect(hiddenContext[0]).toBe("side:boundary");
		expect(hiddenContext[1]).toContain("Summary snapshot leaf: leaf");
		expect(hiddenContext[1]).not.toContain("parent raw context must not be copied");
		expect(hiddenContext[2]).toBe(false);
		expect(controller.state.summaryStatus).toBe("pending");
		await controller.dispose();
	});
});
