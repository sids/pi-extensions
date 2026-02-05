import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	keyHint,
	truncateHead,
} from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import {
	buildErrorPayload,
	parseErrorPayload,
	resolveCount,
	resolveQueries,
} from "./utils";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const webSearchSchema = Type.Object(
	{
		query: Type.Optional(Type.String({ description: "Search query." })),
		queries: Type.Optional(
			Type.Array(Type.String({ description: "Multiple search queries." })),
		),
		count: Type.Optional(
			Type.Integer({
				description:
					"Number of results per query (max 20). Defaults to 10 for single query or 5 for multiple queries.",
				minimum: 1,
				maximum: 20,
			}),
		),
	},
	{ additionalProperties: false },
);

type WebSearchParams = Static<typeof webSearchSchema>;

type BraveWebResult = {
	title?: string;
	url?: string;
	description?: string;
	age?: string;
	page_age?: string;
};

type BraveWebResponse = {
	web?: {
		results?: BraveWebResult[];
	};
};

type WebSearchItem = {
	title: string;
	url: string;
	snippet: string;
	age?: string;
};

type WebSearchGroup = {
	query: string;
	items: WebSearchItem[];
};

type WebSearchDetails = {
	results: WebSearchGroup[];
	count: number;
	requestedCount?: number;
	truncation?: ReturnType<typeof truncateHead>;
	fullOutputPath?: string;
};

type BraveResponseResult =
	| { ok: true; data: BraveWebResponse }
	| {
		ok: false;
		status: number;
		statusText: string;
		errorText: string;
		errorCode?: string;
		errorDetail?: string;
	};

const BRAVE_PROVIDER_ID = "brave-search";
const BRAVE_FALLBACK_PROVIDER_ID = "brave-search-fallback";

async function requestBraveResults(
	query: string,
	count: number,
	apiKey: string,
	signal?: AbortSignal,
): Promise<BraveResponseResult> {
	const url = new URL("https://api.search.brave.com/res/v1/web/search");
	url.searchParams.set("q", query);
	url.searchParams.set("count", count.toString());

	const response = await fetch(url.toString(), {
		headers: {
			Accept: "application/json",
			"Accept-Encoding": "gzip",
			"X-Subscription-Token": apiKey,
		},
		signal,
	});

	if (!response.ok) {
		const errorText = await response.text();
		let errorCode: string | undefined;
		let errorDetail: string | undefined;

		try {
			const parsed = JSON.parse(errorText) as {
				error?: { detail?: string; code?: string };
			};
			errorCode = parsed.error?.code;
			errorDetail = parsed.error?.detail;
		} catch {
			// ignore parse errors
		}

		return {
			ok: false,
			status: response.status,
			statusText: response.statusText,
			errorText,
			errorCode,
			errorDetail,
		};
	}

	const data = (await response.json()) as BraveWebResponse;
	return { ok: true, data };
}

async function fetchBraveResults(
	query: string,
	count: number,
	apiKey: string,
	fallbackApiKey: string | undefined,
	signal?: AbortSignal,
): Promise<WebSearchItem[]> {
	let result = await requestBraveResults(query, count, apiKey, signal);
	const isRateLimited =
		!result.ok && (result.status === 429 || result.errorCode === "RATE_LIMITED");
	if (isRateLimited && fallbackApiKey && fallbackApiKey !== apiKey) {
		result = await requestBraveResults(query, count, fallbackApiKey, signal);
	}

	if (!result.ok) {
		const detail = result.errorDetail ?? result.errorText;
		throw new Error(
			`Brave Search API error (${result.status} ${result.statusText}): ${detail}`,
		);
	}

	const results = result.data.web?.results ?? [];

	return results.slice(0, count).map((item) => ({
		title: item.title ?? "",
		url: item.url ?? "",
		snippet: item.description ?? "",
		age: item.age ?? item.page_age ?? undefined,
	}));
}

function formatResults(groups: WebSearchGroup[]): string {
	return groups
		.map((group, index) => {
			const header =
				groups.length > 1
					? `--- Query ${index + 1}: ${group.query} ---`
					: `--- Results for: ${group.query} ---`;
			const lines = [header];
			if (group.items.length === 0) {
				lines.push("(no results)");
				return lines.join("\n");
			}

			group.items.forEach((item, idx) => {
				const title = item.title || item.url || "(untitled)";
				lines.push(`${idx + 1}. ${title}`);
				lines.push(`   URL: ${item.url || "(missing url)"}`);
				if (item.age) {
					lines.push(`   Age: ${item.age}`);
				}
				if (item.snippet) {
					lines.push(`   Snippet: ${item.snippet}`);
				}
			});

			return lines.join("\n");
		})
		.join("\n\n");
}


function buildQueryLine(count: number, queryCount: number): string {
	return queryCount > 1
		? `${queryCount} queries (${count} results each)`
		: `${count} results`;
}

function renderQueries(
	queries: string[],
	theme: { fg: (color: string, text: string) => string },
): string[] {
	if (queries.length === 0) {
		return [theme.fg("muted", "(no query)")];
	}
	if (queries.length === 1) {
		return [theme.fg("accent", queries[0])];
	}
	return queries.map((query) => `• ${theme.fg("accent", query)}`);
}

function buildResultLines(
	groups: WebSearchGroup[],
	expanded: boolean,
	theme: { fg: (color: string, text: string) => string },
): string[] {
	const lines: string[] = [];
	const showGroupHeader = groups.length > 1;

	groups.forEach((group, index) => {
		if (showGroupHeader) {
			lines.push(theme.fg("accent", `Query ${index + 1}: ${group.query}`));
		}

		if (group.items.length === 0) {
			lines.push(theme.fg("muted", "(no results)"));
			lines.push("");
			return;
		}

		group.items.forEach((item, idx) => {
			const title = item.title || item.url || "(untitled)";
			const url = item.url || "(missing url)";
			lines.push(`${idx + 1}. ${title}`);
			lines.push(`   ${theme.fg("dim", url)}`);

			if (expanded) {
				if (item.age) {
					lines.push(`   ${theme.fg("muted", `Age: ${item.age}`)}`);
				}
				if (item.snippet) {
					lines.push(`   ${theme.fg("muted", `Snippet: ${item.snippet}`)}`);
				}
			}
		});

		lines.push("");
	});

	if (lines.length > 0 && lines[lines.length - 1] === "") {
		lines.pop();
	}

	return lines;
}

function extractText(result: { content?: Array<{ type: string; text?: string }> }): string {
	if (!result.content) return "";
	return result.content
		.map((block) => (block.type === "text" ? block.text ?? "" : ""))
		.join("\n")
		.trim();
}

async function writeTempOutput(content: string): Promise<string> {
	const id = randomBytes(8).toString("hex");
	const path = join(tmpdir(), `pi-web-search-${id}.log`);
	await writeFile(path, content, "utf8");
	return path;
}

async function promptAndSaveApiKey(
	ctx: ExtensionCommandContext,
	providerId: string,
	label: string,
) {
	if (!ctx.hasUI) {
		throw new Error("web-search-setup requires interactive mode");
	}

	const existing = ctx.modelRegistry.authStorage.get(providerId);
	if (existing) {
		const confirm = await ctx.ui.confirm(
			`Overwrite ${label} Brave Search API key?`,
			`An API key is already stored for ${providerId}. Replace it?`,
		);
		if (!confirm) {
			return false;
		}
	}

	const apiKey = await ctx.ui.input(`${label} Brave Search API key`, "BSA-... or sk-...");
	if (!apiKey) {
		return false;
	}

	const trimmed = apiKey.trim();
	if (!trimmed) {
		ctx.ui.notify("Brave Search API key not saved (empty input)", "warning");
		return false;
	}

	ctx.modelRegistry.authStorage.set(providerId, { type: "api_key", key: trimmed });
	ctx.ui.notify(`${label} Brave Search API key saved`, "info");
	return true;
}

function resolveSetupMode(args: string | undefined) {
	const normalized = (args ?? "").trim().toLowerCase();
	const wantsFallback = normalized.includes("fallback");
	const wantsPrimary = normalized.includes("primary");

	if (wantsFallback && !wantsPrimary) {
		return "fallback" as const;
	}
	if (wantsPrimary && !wantsFallback) {
		return "primary" as const;
	}
	if (wantsFallback && wantsPrimary) {
		return "both" as const;
	}
	return "both" as const;
}

async function runSetup(ctx: ExtensionCommandContext, args: string | undefined) {
	const mode = resolveSetupMode(args);

	if (mode === "primary" || mode === "both") {
		await promptAndSaveApiKey(ctx, BRAVE_PROVIDER_ID, "Primary");
	}

	if (mode === "fallback") {
		await promptAndSaveApiKey(ctx, BRAVE_FALLBACK_PROVIDER_ID, "Fallback");
		return;
	}

	if (mode === "both") {
		const confirmFallback = await ctx.ui.confirm(
			"Add fallback API key?",
			"Optional: used when the primary Brave Search key hits rate limits.",
		);
		if (confirmFallback) {
			await promptAndSaveApiKey(ctx, BRAVE_FALLBACK_PROVIDER_ID, "Fallback");
		}
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("web-search-setup", {
		description: "Configure Brave Search API keys for web_search (primary/fallback)",
		handler: async (args, ctx) => {
			await runSetup(ctx, args);
		},
	});
	pi.registerTool({
		name: "web_search",
		label: "web_search",
		description:
			"Search the web via Brave Search API. Provide query or queries; optional count (max 20) per query. Returns titles, URLs, and snippets. Output is truncated to 2000 lines or 50KB.",
		parameters: webSearchSchema,
		renderCall: (args, theme) => {
			const queries = resolveQueries(args);
			const count = resolveCount(args, queries.length || 1);
			const queryLines = renderQueries(queries, theme);
			const toolTitle = theme.fg("toolTitle", theme.bold("web_search"));
			const countLine = theme.fg("muted", buildQueryLine(count, queries.length || 1));

			const lines: string[] = [];
			if (queries.length === 1) {
				lines.push(`${toolTitle} ${queryLines[0]}`);
			} else {
				lines.push(toolTitle);
			}
			lines.push(countLine);
			if (queries.length > 1) {
				lines.push("");
			}

			return new Text(lines.join("\n"), 0, 0);
		},
		renderResult: (result, { expanded, isPartial }, theme) => {
			if (isPartial) {
				return new Text(theme.fg("muted", "Searching..."), 0, 0);
			}

			const details = result.details as WebSearchDetails | undefined;
			if (!details?.results) {
				const fallback = extractText(result) || "(no results)";
				const errorPayload = parseErrorPayload(fallback);
				if (!errorPayload) {
					return new Text(fallback, 0, 0);
				}

				const errorLines: string[] = [];
				if (errorPayload.queries.length === 1) {
					const queryLine = renderQueries(errorPayload.queries, theme)[0] ?? "";
					errorLines.push(`${theme.fg("muted", "Query:")} ${queryLine}`);
				} else if (errorPayload.queries.length > 1) {
					errorLines.push(theme.fg("muted", "Queries:"));
					errorLines.push(...renderQueries(errorPayload.queries, theme));
				}

				errorLines.push(theme.fg("error", errorPayload.message));
				return new Text(errorLines.join("\n"), 0, 0);
			}

			const lines: string[] = [];
			lines.push(...buildResultLines(details.results, expanded, theme));

			if (details.truncation && details.fullOutputPath) {
				const trunc = details.truncation;
				lines.push(
					theme.fg(
						"warning",
						`Output truncated (${trunc.outputLines}/${trunc.totalLines} lines, ${formatSize(
							trunc.outputBytes,
						)} of ${formatSize(trunc.totalBytes)}). Full output: ${details.fullOutputPath}`,
					),
				);
			}

			if (!expanded) {
				lines.push("");
				lines.push(theme.fg("dim", keyHint("expandTools", "to expand for snippets")));
			}

			return new Text(lines.join("\n"), 0, 0);
		},
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}

			const queries = resolveQueries(params);
			if (queries.length === 0) {
				throw new Error("web_search requires query or queries");
			}

			const primaryApiKey = await ctx.modelRegistry.getApiKeyForProvider(BRAVE_PROVIDER_ID);
			const fallbackApiKey = await ctx.modelRegistry.getApiKeyForProvider(
				BRAVE_FALLBACK_PROVIDER_ID,
			);

			const apiKey = primaryApiKey ?? fallbackApiKey;
			const effectiveFallback = primaryApiKey ? fallbackApiKey : undefined;

			if (!apiKey) {
				throw new Error(
					"Brave Search API key not configured. Run /web-search-setup to add it.",
				);
			}

			const count = resolveCount(params, queries.length);
			const groups: WebSearchGroup[] = [];

			for (const query of queries) {
				if (signal?.aborted) {
					throw new Error("Operation aborted");
				}
				try {
					const items = await fetchBraveResults(
						query,
						count,
						apiKey,
						effectiveFallback,
						signal,
					);
					groups.push({ query, items });
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					throw new Error(buildErrorPayload(queries, message));
				}
			}

			const fullOutput = formatResults(groups);
			const truncation = truncateHead(fullOutput, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});

			let outputText = truncation.content || "(no output)";
			const details: WebSearchDetails = {
				results: groups,
				count,
				requestedCount: params.count,
			};

			if (truncation.truncated) {
				const fullOutputPath = await writeTempOutput(fullOutput);
				details.truncation = truncation;
				details.fullOutputPath = fullOutputPath;
				outputText += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (`;
				outputText += `${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
				outputText += ` Full output saved to: ${fullOutputPath}]`;
			}

			return {
				content: [{ type: "text", text: outputText }],
				details,
			};
		},
	});
}
