import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateDiffComments } from "./comments";
import type { ViewerBootstrapPayload, ViewerSession } from "./types";

const HOST = "127.0.0.1";
const APP_JS_BASENAME = "app.js";
const APP_CSS_BASENAME = "app.css";

const PACKAGE_DIR = fileURLToPath(new URL(".", import.meta.url));
const WEB_ENTRY_PATH = fileURLToPath(new URL("./web/index.tsx", import.meta.url));
const WEB_DIST_DIR = fileURLToPath(new URL("./web/dist", import.meta.url));

type AssetManifest = {
	jsPath: string;
	cssPath: string;
};

export type CreateViewerSessionInput = {
	bootstrap: Omit<ViewerBootstrapPayload, "viewerToken">;
	refreshBootstrap?: () => Promise<Omit<ViewerBootstrapPayload, "viewerToken">>;
	loadFile: ViewerSession["loadFile"];
	sendComments: ViewerSession["sendComments"];
};

export type DiffCmuxServerOptions = {
	buildAssets?: () => Promise<AssetManifest>;
};

function isValidViewerToken(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function ensureViewerAssetsBuilt(): Promise<AssetManifest> {
	const jsPath = path.join(WEB_DIST_DIR, APP_JS_BASENAME);
	const cssPath = path.join(WEB_DIST_DIR, APP_CSS_BASENAME);
	try {
		await Promise.all([readFile(jsPath), readFile(cssPath)]);
		return { jsPath, cssPath };
	} catch {
		const esbuild = await import("esbuild");
		await esbuild.build({
			absWorkingDir: PACKAGE_DIR,
			entryPoints: [WEB_ENTRY_PATH],
			bundle: true,
			format: "esm",
			platform: "browser",
			jsx: "automatic",
			entryNames: "app",
			outdir: WEB_DIST_DIR,
			loader: {
				".css": "css",
			},
			define: {
				"process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "production"),
			},
		});
		return { jsPath, cssPath };
	}
}

function renderHtmlShell(token: string): string {
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>pi diff cmux</title>
	<link rel="stylesheet" href="/assets/${APP_CSS_BASENAME}" />
</head>
<body>
	<div id="root"></div>
	<script>window.__PI_DIFF_CMUX_VIEWER_TOKEN__ = ${JSON.stringify(token)};</script>
	<script type="module" src="/assets/${APP_JS_BASENAME}"></script>
</body>
</html>`;
}

function json(response: ServerResponse, statusCode: number, value: unknown) {
	response.statusCode = statusCode;
	response.setHeader("Content-Type", "application/json; charset=utf-8");
	response.end(JSON.stringify(value));
}

async function readJsonRequestBody(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	const rawBody = Buffer.concat(chunks).toString("utf8");
	if (!rawBody.trim()) {
		return {};
	}
	return JSON.parse(rawBody);
}

export class DiffCmuxServer {
	private readonly sessions = new Map<string, ViewerSession>();
	private readonly buildAssets: () => Promise<AssetManifest>;
	private readonly server = createServer(this.handleRequest.bind(this));
	private startPromise: Promise<void> | null = null;
	private stopped = false;
	private port: number | null = null;

	constructor(options: DiffCmuxServerOptions = {}) {
		this.buildAssets = options.buildAssets ?? ensureViewerAssetsBuilt;
	}

	async start(): Promise<void> {
		if (this.port !== null) {
			return;
		}
		if (this.startPromise) {
			return await this.startPromise;
		}
		this.startPromise = new Promise<void>((resolve, reject) => {
			this.server.listen(0, HOST, () => {
				const address = this.server.address();
				if (!address || typeof address === "string") {
					reject(new Error("Failed to bind the diff viewer server."));
					return;
				}
				this.port = address.port;
				resolve();
			});
			this.server.once("error", reject);
		});
		try {
			await this.startPromise;
		} finally {
			this.startPromise = null;
		}
	}

	async stop(): Promise<void> {
		if (this.stopped) {
			return;
		}
		this.stopped = true;
		this.sessions.clear();
		if (this.port === null) {
			return;
		}
		await new Promise<void>((resolve, reject) => {
			this.server.close((error) => {
				if (error) {
					reject(error);
					return;
				}
				resolve();
			});
		});
		this.port = null;
	}

	async createViewerSession(input: CreateViewerSessionInput): Promise<{ token: string; url: string }> {
		await this.start();
		const token = randomUUID();
		this.sessions.set(token, {
			token,
			bootstrap: {
				...input.bootstrap,
				viewerToken: token,
			},
			refreshBootstrap: input.refreshBootstrap
				? async () => ({
					...(await input.refreshBootstrap()),
					viewerToken: token,
				})
				: undefined,
			loadFile: input.loadFile,
			sendComments: input.sendComments,
		});
		return {
			token,
			url: this.getViewerUrl(token),
		};
	}

	getViewerUrl(token: string): string {
		if (this.port === null) {
			throw new Error("The diff viewer server has not started yet.");
		}
		return `http://${HOST}:${this.port}/viewer/${token}`;
	}

	private async serveAsset(response: ServerResponse, assetPath: string, contentType: string) {
		const content = await readFile(assetPath);
		response.statusCode = 200;
		response.setHeader("Content-Type", `${contentType}; charset=utf-8`);
		response.end(content);
	}

	private async handleRequest(request: IncomingMessage, response: ServerResponse) {
		try {
			const url = new URL(request.url ?? "/", `http://${HOST}`);
			const pathname = url.pathname;

			if (pathname === `/assets/${APP_JS_BASENAME}`) {
				const assets = await this.buildAssets();
				await this.serveAsset(response, assets.jsPath, "text/javascript");
				return;
			}
			if (pathname === `/assets/${APP_CSS_BASENAME}`) {
				const assets = await this.buildAssets();
				await this.serveAsset(response, assets.cssPath, "text/css");
				return;
			}

			const viewerMatch = pathname.match(/^\/viewer\/([^/]+)$/);
			if (viewerMatch) {
				const token = viewerMatch[1] ?? "";
				if (!isValidViewerToken(token)) {
					json(response, 400, { error: "Invalid viewer token." });
					return;
				}
				response.statusCode = 200;
				response.setHeader("Content-Type", "text/html; charset=utf-8");
				response.end(renderHtmlShell(token));
				return;
			}

			const bootstrapMatch = pathname.match(/^\/api\/viewer\/([^/]+)$/);
			if (bootstrapMatch) {
				const token = bootstrapMatch[1] ?? "";
				if (!isValidViewerToken(token)) {
					json(response, 400, { error: "Invalid viewer token." });
					return;
				}
				const session = this.sessions.get(token);
				if (!session) {
					json(response, 404, { error: "Viewer session expired." });
					return;
				}
				if (session.refreshBootstrap) {
					session.bootstrap = await session.refreshBootstrap();
				}
				json(response, 200, session.bootstrap);
				return;
			}

			const fileMatch = pathname.match(/^\/api\/viewer\/([^/]+)\/files\/([^/]+)$/);
			if (fileMatch) {
				const token = fileMatch[1] ?? "";
				const fileId = fileMatch[2] ?? "";
				if (!isValidViewerToken(token)) {
					json(response, 400, { error: "Invalid viewer token." });
					return;
				}
				const session = this.sessions.get(token);
				if (!session) {
					json(response, 404, { error: "Viewer session expired." });
					return;
				}
				const filePayload = await session.loadFile(fileId);
				if (!filePayload) {
					json(response, 404, { error: "Diff file not found." });
					return;
				}
				json(response, 200, filePayload);
				return;
			}

			const sendMatch = pathname.match(/^\/api\/viewer\/([^/]+)\/send$/);
			if (sendMatch && request.method === "POST") {
				const token = sendMatch[1] ?? "";
				if (!isValidViewerToken(token)) {
					json(response, 400, { error: "Invalid viewer token." });
					return;
				}
				const session = this.sessions.get(token);
				if (!session) {
					json(response, 404, { error: "Viewer session expired." });
					return;
				}
				const body = await readJsonRequestBody(request);
				const rawComments = typeof body === "object" && body !== null && "comments" in body ? (body as { comments?: unknown }).comments : undefined;
				let comments;
				try {
					comments = validateDiffComments(rawComments);
				} catch (error) {
					json(response, 400, { error: error instanceof Error ? error.message : "Invalid comments." });
					return;
				}
				if (comments.length === 0) {
					json(response, 400, { error: "No comments were provided." });
					return;
				}
				const result = await session.sendComments(comments);
				json(response, 200, result);
				return;
			}

			json(response, 404, { error: "Not found." });
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown server error.";
			json(response, 500, { error: message });
		}
	}
}

export function createDiffCmuxServer(options: DiffCmuxServerOptions = {}): DiffCmuxServer {
	return new DiffCmuxServer(options);
}
