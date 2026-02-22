import { describe, expect, test } from "bun:test";
import { checkoutPullRequestTarget, resolveReviewTarget } from "../target-selector";

describe("resolveReviewTarget selector", () => {
	test("keeps configured selector order when smart default is uncommitted", async () => {
		let labelsSeen: string[] | undefined;
		const pi = {
			exec: async (command: string, args: string[]) => {
				if (command === "git" && args[0] === "status") {
					return { code: 0, stdout: " M src/review.ts\n", stderr: "" };
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

		const target = await resolveReviewTarget(pi, ctx, "");
		expect(target).toBeNull();
		expect(labelsSeen).toEqual([
			"Review uncommitted changes",
			"Review a commit",
			"Review against a base branch (local)",
			"Review a pull request (GitHub PR)",
			"Review a folder (or more) (snapshot, not diff)",
			"Custom review instructions",
		]);
	});

	test("moves base-branch preset to the front on feature branches", async () => {
		let labelsSeen: string[] | undefined;
		const pi = {
			exec: async (command: string, args: string[]) => {
				if (command === "git" && args[0] === "status") {
					return { code: 0, stdout: "", stderr: "" };
				}
				if (command === "git" && args[0] === "branch" && args[1] === "--show-current") {
					return { code: 0, stdout: "feature/review\n", stderr: "" };
				}
				if (command === "git" && args[0] === "branch" && args[1] === "--format=%(refname:short)") {
					return { code: 0, stdout: "feature/review\nmain\n", stderr: "" };
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

		const target = await resolveReviewTarget(pi, ctx, "");
		expect(target).toBeNull();
		expect(labelsSeen).toEqual([
			"Review against a base branch (local)",
			"Review a commit",
			"Review a pull request (GitHub PR)",
			"Review a folder (or more) (snapshot, not diff)",
			"Custom review instructions",
		]);
	});

	test("moves commit preset to the front on default branch when working tree is clean", async () => {
		let labelsSeen: string[] | undefined;
		const pi = {
			exec: async (command: string, args: string[]) => {
				if (command === "git" && args[0] === "status") {
					return { code: 0, stdout: "", stderr: "" };
				}
				if (command === "git" && args[0] === "branch" && args[1] === "--show-current") {
					return { code: 0, stdout: "main\n", stderr: "" };
				}
				if (command === "git" && args[0] === "branch" && args[1] === "--format=%(refname:short)") {
					return { code: 0, stdout: "main\nfeature/review\n", stderr: "" };
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

		const target = await resolveReviewTarget(pi, ctx, "");
		expect(target).toBeNull();
		expect(labelsSeen).toEqual([
			"Review a commit",
			"Review against a base branch (local)",
			"Review a pull request (GitHub PR)",
			"Review a folder (or more) (snapshot, not diff)",
			"Custom review instructions",
		]);
	});

	test("falls back to commit when there are no alternate local branches", async () => {
		let labelsSeen: string[] | undefined;
		const pi = {
			exec: async (command: string, args: string[]) => {
				if (command === "git" && args[0] === "status") {
					return { code: 0, stdout: "", stderr: "" };
				}
				if (command === "git" && args[0] === "branch" && args[1] === "--show-current") {
					return { code: 0, stdout: "feature/review\n", stderr: "" };
				}
				if (command === "git" && args[0] === "branch" && args[1] === "--format=%(refname:short)") {
					return { code: 0, stdout: "feature/review\n", stderr: "" };
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

		const target = await resolveReviewTarget(pi, ctx, "");
		expect(target).toBeNull();
		expect(labelsSeen).toEqual([
			"Review a commit",
			"Review against a base branch (local)",
			"Review a pull request (GitHub PR)",
			"Review a folder (or more) (snapshot, not diff)",
			"Custom review instructions",
		]);
	});

	test("falls back to commit when default-branch detection is not reliable", async () => {
		let labelsSeen: string[] | undefined;
		const pi = {
			exec: async (command: string, args: string[]) => {
				if (command === "git" && args[0] === "status") {
					return { code: 0, stdout: "", stderr: "" };
				}
				if (command === "git" && args[0] === "branch" && args[1] === "--show-current") {
					return { code: 0, stdout: "feature/review\n", stderr: "" };
				}
				if (command === "git" && args[0] === "branch" && args[1] === "--format=%(refname:short)") {
					return { code: 0, stdout: "feature/review\nmain\n", stderr: "" };
				}
				if (command === "git" && args[0] === "symbolic-ref") {
					return { code: 1, stdout: "", stderr: "origin/HEAD not found" };
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

		const target = await resolveReviewTarget(pi, ctx, "");
		expect(target).toBeNull();
		expect(labelsSeen).toEqual([
			"Review a commit",
			"Review against a base branch (local)",
			"Review a pull request (GitHub PR)",
			"Review a folder (or more) (snapshot, not diff)",
			"Custom review instructions",
		]);
	});

	test("returns empty custom target when selecting custom preset", async () => {
		let editorCalled = false;
		const pi = {
			exec: async (_command: string, _args: string[]) => ({ code: 0, stdout: "", stderr: "" }),
		} as any;
		const ctx = {
			cwd: "/tmp/project",
			ui: {
				select: async (_prompt: string, labels: string[]) => {
					return labels.find((label) => label === "Custom review instructions");
				},
				editor: async () => {
					editorCalled = true;
					return "should not be called";
				},
				notify: () => {},
			},
		} as any;

		const target = await resolveReviewTarget(pi, ctx, "");
		expect(target).toEqual({ type: "custom", instructions: "" });
		expect(editorCalled).toBe(false);
	});

	test("accepts /review custom without instructions", async () => {
		const pi = {
			exec: async (_command: string, _args: string[]) => ({ code: 0, stdout: "", stderr: "" }),
		} as any;
		const ctx = {
			cwd: "/tmp/project",
			ui: {
				notify: () => {},
			},
		} as any;

		const target = await resolveReviewTarget(pi, ctx, "custom");
		expect(target).toEqual({ type: "custom", instructions: "" });
	});

	test("shows error for /review uncommitted when working tree is clean", async () => {
		const notifications: Array<{ message: string; level: string }> = [];
		const pi = {
			exec: async (command: string, args: string[]) => {
				if (command === "git" && args[0] === "status") {
					return { code: 0, stdout: "", stderr: "" };
				}
				return { code: 0, stdout: "", stderr: "" };
			},
		} as any;
		const ctx = {
			cwd: "/tmp/project",
			ui: {
				notify: (message: string, level: string) => notifications.push({ message, level }),
			},
		} as any;

		const target = await resolveReviewTarget(pi, ctx, "uncommitted");
		expect(target).toBeNull();
		expect(notifications).toContainEqual({
			message: "No uncommitted changes found",
			level: "error",
		});
	});

	test("shows error for invalid direct args and does not open selector", async () => {
		const notifications: Array<{ message: string; level: string }> = [];
		let selectCalled = false;
		const pi = {
			exec: async (_command: string, _args: string[]) => ({ code: 0, stdout: "", stderr: "" }),
		} as any;
		const ctx = {
			cwd: "/tmp/project",
			ui: {
				select: async () => {
					selectCalled = true;
					return undefined;
				},
				notify: (message: string, level: string) => notifications.push({ message, level }),
			},
		} as any;

		const target = await resolveReviewTarget(pi, ctx, "wat");
		expect(target).toBeNull();
		expect(selectCalled).toBe(false);
		expect(notifications).toContainEqual({
			message:
				"Invalid /review args. Use uncommitted, branch <name>, commit <sha>, folder <paths>, custom [instructions], or pr <number-or-url>.",
			level: "error",
		});
	});
});

describe("resolveReviewTarget pull request refs", () => {
	test("preserves full GitHub URL when fetching PR info", async () => {
		const execCalls: Array<{ command: string; args: string[] }> = [];
		const pi = {
			exec: async (command: string, args: string[]) => {
				execCalls.push({ command, args });
				if (command === "git" && args[0] === "status") {
					return { code: 0, stdout: "", stderr: "" };
				}
				if (command === "gh" && args[0] === "pr" && args[1] === "view") {
					return {
						code: 0,
						stdout: JSON.stringify({
							baseRefName: "main",
							title: "Fix URL handling",
							headRefName: "fix/url-pr-ref",
						}),
						stderr: "",
					};
				}
				throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
			},
		} as any;

		const ctx = {
			cwd: "/tmp/project",
			ui: {
				notify: () => {},
			},
		} as any;

		const target = await resolveReviewTarget(pi, ctx, "pr https://github.com/acme/widgets/pull/42");
		expect(target).toEqual({
			type: "pullRequest",
			prNumber: 42,
			baseBranch: "main",
			title: "Fix URL handling",
			ghRef: "https://github.com/acme/widgets/pull/42",
		});

		const ghViewCall = execCalls.find((call) => call.command === "gh" && call.args[1] === "view");
		expect(ghViewCall?.args[2]).toBe("https://github.com/acme/widgets/pull/42");
	});

	test("shows not-found notification when gh pr view fails", async () => {
		const notifications: Array<{ message: string; level: string }> = [];
		const pi = {
			exec: async (command: string, args: string[]) => {
				if (command === "git" && args[0] === "status") {
					return { code: 0, stdout: "", stderr: "" };
				}
				if (command === "gh" && args[0] === "pr" && args[1] === "view") {
					return { code: 1, stdout: "", stderr: "not found" };
				}
				throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
			},
		} as any;

		const ctx = {
			cwd: "/tmp/project",
			ui: {
				notify: (message: string, level: string) => notifications.push({ message, level }),
			},
		} as any;

		const target = await resolveReviewTarget(pi, ctx, "pr 42");
		expect(target).toBeNull();
		expect(notifications).toContainEqual({
			message: "Could not find PR #42. Make sure gh is authenticated and the PR exists.",
			level: "error",
		});
	});
});

describe("checkoutPullRequestTarget", () => {
	test("uses preserved ghRef for checkout", async () => {
		const execCalls: Array<{ command: string; args: string[] }> = [];
		const notifications: Array<{ message: string; level: string }> = [];
		const pi = {
			exec: async (command: string, args: string[]) => {
				execCalls.push({ command, args });
				if (command === "git" && args[0] === "status") {
					return { code: 0, stdout: "", stderr: "" };
				}
				if (command === "gh" && args[0] === "pr" && args[1] === "checkout") {
					return { code: 0, stdout: "ok", stderr: "" };
				}
				throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
			},
		} as any;

		const ctx = {
			cwd: "/tmp/project",
			ui: {
				notify: (message: string, level: string) => notifications.push({ message, level }),
			},
		} as any;

		const success = await checkoutPullRequestTarget(pi, ctx, {
			type: "pullRequest",
			prNumber: 42,
			baseBranch: "main",
			title: "Fix URL handling",
			ghRef: "https://github.com/acme/widgets/pull/42",
		});

		expect(success).toBe(true);
		const checkoutCall = execCalls.find((call) => call.command === "gh" && call.args[1] === "checkout");
		expect(checkoutCall?.args[2]).toBe("https://github.com/acme/widgets/pull/42");
		expect(notifications).toContainEqual({ message: "Checked out PR #42", level: "info" });
	});
});
