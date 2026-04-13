import { describe, expect, test } from "bun:test";
import { parseDiffTargetArgs, resolveDiffTargetFromArgs } from "../target-selector";

describe("parseDiffTargetArgs", () => {
	test("parses supported direct args", () => {
		expect(parseDiffTargetArgs("uncommitted")).toEqual({ type: "uncommitted" });
		expect(parseDiffTargetArgs("branch main")).toEqual({ type: "baseBranch", branch: "main" });
		expect(parseDiffTargetArgs("commit abc123 Fix thing")).toEqual({
			type: "commit",
			sha: "abc123",
			title: "Fix thing",
		});
	});
});

describe("resolveDiffTargetFromArgs", () => {
	test("keeps uncommitted first when the working tree is dirty", async () => {
		let labelsSeen: string[] | undefined;
		const pi = {
			exec: async (command: string, args: string[]) => {
				if (command === "git" && args[0] === "status") {
					return { code: 0, stdout: " M src/index.ts\n", stderr: "" };
				}
				return { code: 0, stdout: "", stderr: "" };
			},
		} as any;
		const ctx = {
			cwd: "/tmp/project",
			ui: {
				select: async (_prompt: string, labels: string[]) => {
					labelsSeen = labels;
					return undefined;
				},
				notify: () => {},
			},
		} as any;

		await expect(resolveDiffTargetFromArgs(pi, ctx, "")).resolves.toBeNull();
		expect(labelsSeen).toEqual([
			"Review uncommitted changes",
			"Compare against a branch",
			"Review a commit",
		]);
	});

	test("moves branch comparison to the front on a clean feature branch", async () => {
		let labelsSeen: string[] | undefined;
		const pi = {
			exec: async (command: string, args: string[]) => {
				if (command === "git" && args[0] === "status") {
					return { code: 0, stdout: "", stderr: "" };
				}
				if (command === "git" && args[0] === "branch" && args[1] === "--show-current") {
					return { code: 0, stdout: "feature/diff\n", stderr: "" };
				}
				if (command === "git" && args[0] === "branch" && args[1] === "--format=%(refname:short)") {
					return { code: 0, stdout: "feature/diff\nmain\n", stderr: "" };
				}
				if (command === "git" && args[0] === "symbolic-ref") {
					return { code: 0, stdout: "origin/main\n", stderr: "" };
				}
				return { code: 0, stdout: "", stderr: "" };
			},
		} as any;
		const ctx = {
			cwd: "/tmp/project",
			ui: {
				select: async (_prompt: string, labels: string[]) => {
					labelsSeen = labels;
					return undefined;
				},
				notify: () => {},
			},
		} as any;

		await expect(resolveDiffTargetFromArgs(pi, ctx, "")).resolves.toBeNull();
		expect(labelsSeen).toEqual(["Compare against a branch", "Review a commit"]);
	});

	test("selects a branch interactively", async () => {
		const pi = {
			exec: async (command: string, args: string[]) => {
				if (command === "git" && args[0] === "status") {
					return { code: 0, stdout: "", stderr: "" };
				}
				if (command === "git" && args[0] === "branch" && args[1] === "--show-current") {
					return { code: 0, stdout: "feature/diff\n", stderr: "" };
				}
				if (command === "git" && args[0] === "branch" && args[1] === "--format=%(refname:short)") {
					return { code: 0, stdout: "feature/diff\nmain\nrelease\n", stderr: "" };
				}
				if (command === "git" && args[0] === "symbolic-ref") {
					return { code: 0, stdout: "origin/main\n", stderr: "" };
				}
				return { code: 0, stdout: "", stderr: "" };
			},
		} as any;
		const selections: string[] = [];
		const ctx = {
			cwd: "/tmp/project",
			ui: {
				select: async (_prompt: string, labels: string[]) => {
					selections.push(labels.join(" | "));
					if (labels.includes("Compare against a branch")) {
						return "Compare against a branch";
					}
					return "main (default)";
				},
				notify: () => {},
			},
		} as any;

		await expect(resolveDiffTargetFromArgs(pi, ctx, "")).resolves.toEqual({ type: "baseBranch", branch: "main" });
		expect(selections).toHaveLength(2);
	});

	test("selects a commit interactively", async () => {
		const pi = {
			exec: async (command: string, args: string[]) => {
				if (command === "git" && args[0] === "status") {
					return { code: 0, stdout: "", stderr: "" };
				}
				if (command === "git" && args[0] === "branch" && args[1] === "--show-current") {
					return { code: 0, stdout: "main\n", stderr: "" };
				}
				if (command === "git" && args[0] === "branch" && args[1] === "--format=%(refname:short)") {
					return { code: 0, stdout: "main\nfeature/diff\n", stderr: "" };
				}
				if (command === "git" && args[0] === "symbolic-ref") {
					return { code: 0, stdout: "origin/main\n", stderr: "" };
				}
				if (command === "git" && args[0] === "log") {
					return { code: 0, stdout: "abc1234 First\ndef5678 Second\n", stderr: "" };
				}
				return { code: 0, stdout: "", stderr: "" };
			},
		} as any;
		const ctx = {
			cwd: "/tmp/project",
			ui: {
				select: async (_prompt: string, labels: string[]) => {
					if (labels.includes("Review a commit")) {
						return "Review a commit";
					}
					return "abc1234 First";
				},
				notify: () => {},
			},
		} as any;

		await expect(resolveDiffTargetFromArgs(pi, ctx, "")).resolves.toEqual({
			type: "commit",
			sha: "abc1234",
			title: "First",
		});
	});

	test("shows an error for invalid args", async () => {
		const notifications: Array<{ message: string; level: string }> = [];
		const pi = {
			exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		} as any;
		const ctx = {
			cwd: "/tmp/project",
			ui: {
				notify: (message: string, level: string) => notifications.push({ message, level }),
			},
		} as any;

		await expect(resolveDiffTargetFromArgs(pi, ctx, "wat")).resolves.toBeNull();
		expect(notifications).toContainEqual({
			message: "Invalid diff target. Use uncommitted, branch <name>, or commit <sha>.",
			level: "error",
		});
	});
});
