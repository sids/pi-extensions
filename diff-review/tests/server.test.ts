import { afterEach, describe, expect, test } from "vitest";
import { createDiffReviewServer, type DiffReviewServer } from "../server";
import type { DiffComment } from "../types";

const bootstrap = {
	repo: { root: "/tmp/project", name: "project", cwd: "/tmp/project" },
	target: {
		type: "uncommitted" as const,
		label: "Uncommitted changes",
		subtitle: "Working tree compared with HEAD",
		baseRev: "HEAD",
		headRev: "HEAD",
		hasHead: true,
	},
	files: [
		{
			id: "file-1",
			path: "src/foo.ts",
			oldPath: null,
			newPath: "src/foo.ts",
			status: "modified" as const,
			anchorId: "diff-file-1-src-foo-ts",
			isBinary: false,
		},
	],
	defaultViewMode: "unified" as const,
};

const COMMENTS: DiffComment[] = [
	{
		id: "file-comment-1",
		kind: "file",
		text: "Please simplify this file.",
		createdAt: 1,
		updatedAt: 1,
		sentAt: null,
		fileId: "file-1",
		path: "src/foo.ts",
		oldPath: null,
		newPath: "src/foo.ts",
	},
];

const servers: DiffReviewServer[] = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.stop()));
});

describe("DiffReviewServer", () => {
	test("serves bootstrap and file payloads for registered sessions", async () => {
		const server = createDiffReviewServer();
		servers.push(server);
		const session = await server.createReviewSession({
			bootstrap,
			loadFile: async (fileId) =>
				fileId === "file-1"
					? {
						file: bootstrap.files[0]!,
						diffText: "diff --git a/src/foo.ts b/src/foo.ts\n--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n-old\n+new\n",
					}
					: null,
			sendComments: async () => ({ sentAt: 123, formattedText: "formatted" }),
		});

		const bootstrapResponse = await fetch(`${session.url.replace(/\/review\/.+$/, "")}/api/review/${session.token}`);
		expect(bootstrapResponse.status).toBe(200);
		expect(await bootstrapResponse.json()).toMatchObject({
			reviewToken: session.token,
			repo: { name: "project" },
			defaultViewMode: "unified",
		});

		const fileResponse = await fetch(`${session.url.replace(/\/review\/.+$/, "")}/api/review/${session.token}/files/file-1`);
		expect(fileResponse.status).toBe(200);
		expect(await fileResponse.json()).toMatchObject({
			file: { id: "file-1", path: "src/foo.ts" },
		});

		const faviconResponse = await fetch(`${session.url.replace(/\/review\/.+$/, "")}/favicon.ico`);
		expect(faviconResponse.status).toBe(200);
		expect(faviconResponse.headers.get("content-type")).toContain("image/svg+xml");
	});

	test("refreshes bootstrap data on subsequent loads", async () => {
		const server = createDiffReviewServer();
		servers.push(server);
		let refreshCount = 0;
		const session = await server.createReviewSession({
			bootstrap,
			refreshBootstrap: async () => {
				refreshCount += 1;
				return {
					...bootstrap,
					files:
						refreshCount === 1
							? bootstrap.files
							: [
								{
									...bootstrap.files[0]!,
									fingerprint: "updated-fingerprint",
								},
							],
				};
			},
			loadFile: async () => null,
			sendComments: async () => ({ sentAt: 123, formattedText: "formatted" }),
		});
		const baseUrl = session.url.replace(/\/review\/.+$/, "");

		const firstBootstrapResponse = await fetch(`${baseUrl}/api/review/${session.token}`);
		expect(firstBootstrapResponse.status).toBe(200);
		expect((await firstBootstrapResponse.json()).files[0]?.fingerprint).toBeUndefined();

		const secondBootstrapResponse = await fetch(`${baseUrl}/api/review/${session.token}`);
		expect(secondBootstrapResponse.status).toBe(200);
		expect((await secondBootstrapResponse.json()).files[0]?.fingerprint).toBe("updated-fingerprint");
	});

	test("validates review tokens and comment payloads", async () => {
		const server = createDiffReviewServer();
		servers.push(server);
		const session = await server.createReviewSession({
			bootstrap,
			loadFile: async () => null,
			sendComments: async () => ({ sentAt: 123, formattedText: "formatted" }),
		});
		const baseUrl = session.url.replace(/\/review\/.+$/, "");

		const invalidTokenResponse = await fetch(`${baseUrl}/api/review/not-a-token`);
		expect(invalidTokenResponse.status).toBe(400);

		const invalidCommentResponse = await fetch(`${baseUrl}/api/review/${session.token}/send`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ comments: [{ bad: true }] }),
		});
		expect(invalidCommentResponse.status).toBe(400);
	});

	test("sends comments through the registered session", async () => {
		const server = createDiffReviewServer();
		servers.push(server);
		let receivedComments: DiffComment[] = [];
		const session = await server.createReviewSession({
			bootstrap,
			loadFile: async () => null,
			sendComments: async (comments) => {
				receivedComments = comments;
				return { sentAt: 456, formattedText: "formatted comments" };
			},
		});
		const baseUrl = session.url.replace(/\/review\/.+$/, "");

		const sendResponse = await fetch(`${baseUrl}/api/review/${session.token}/send`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ comments: COMMENTS }),
		});
		expect(sendResponse.status).toBe(200);
		expect(await sendResponse.json()).toEqual({ sentAt: 456, formattedText: "formatted comments" });
		expect(receivedComments).toEqual(COMMENTS);
	});
});
