import { describe, expect, test } from "vitest";
import { summarizeLoadedContext, type SystemPromptDiagnosticContext } from "../system-prompt-diagnostic";

function ctx(overrides: Partial<SystemPromptDiagnosticContext> = {}): SystemPromptDiagnosticContext {
	return {
		getSystemPromptOptions: () => ({}),
		...overrides,
	};
}

describe("summarizeLoadedContext", () => {
	test("returns empty string for empty options", () => {
		expect(summarizeLoadedContext(ctx())).toBe("");
	});

	test("returns empty string when getSystemPromptOptions is absent", () => {
		expect(summarizeLoadedContext({})).toBe("");
	});

	test("handles missing contextFiles and skills gracefully", () => {
		expect(
			summarizeLoadedContext(
				ctx({
					getSystemPromptOptions: () => ({ contextFiles: [], skills: [] }),
				}),
			),
		).toBe("");
	});

	test("formats a single context file", () => {
		const result = summarizeLoadedContext(
			ctx({
				getSystemPromptOptions: () => ({
					contextFiles: [{ path: "/project/AGENTS.md", content: "..." }],
				}),
			}),
		);
		expect(result).toBe("1 context file");
	});

	test("formats multiple context files", () => {
		const result = summarizeLoadedContext(
			ctx({
				getSystemPromptOptions: () => ({
					contextFiles: [
						{ path: "/project/AGENTS.md", content: "..." },
						{ path: "/home/user/.pi/agent/AGENTS.md", content: "..." },
						{ path: "/parent/AGENTS.md", content: "..." },
					],
				}),
			}),
		);
		expect(result).toBe("3 context files");
	});

	test("formats a single skill", () => {
		const result = summarizeLoadedContext(
			ctx({
				getSystemPromptOptions: () => ({
					skills: [{ name: "github" }],
				}),
			}),
		);
		expect(result).toBe("1 skill: github");
	});

	test("formats up to 3 skills with names", () => {
		const result = summarizeLoadedContext(
			ctx({
				getSystemPromptOptions: () => ({
					skills: [
						{ name: "github" },
						{ name: "adx-query" },
						{ name: "pdf" },
					],
				}),
			}),
		);
		expect(result).toBe("3 skills: github, adx-query, pdf");
	});

	test("formats more than 3 skills with overflow suffix", () => {
		const result = summarizeLoadedContext(
			ctx({
				getSystemPromptOptions: () => ({
					skills: [
						{ name: "github" },
						{ name: "adx-query" },
						{ name: "pdf" },
						{ name: "yeet" },
						{ name: "tmux" },
					],
				}),
			}),
		);
		expect(result).toBe("5 skills: github, adx-query, pdf, +2 more");
	});

	test("formats context files and skills together", () => {
		const result = summarizeLoadedContext(
			ctx({
				getSystemPromptOptions: () => ({
					contextFiles: [
						{ path: "/project/AGENTS.md", content: "..." },
						{ path: "/parent/AGENTS.md", content: "..." },
					],
					skills: [
						{ name: "github" },
						{ name: "yeet" },
					],
				}),
			}),
		);
		expect(result).toBe("2 context files • 2 skills: github, yeet");
	});

	test("returns empty string when getSystemPromptOptions throws", () => {
		const result = summarizeLoadedContext(
			ctx({
				getSystemPromptOptions: () => {
					throw new Error("unavailable");
				},
			}),
		);
		expect(result).toBe("");
	});
});
