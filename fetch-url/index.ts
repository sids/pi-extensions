import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type, type Static } from "@sinclair/typebox";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	convertHtmlToMarkdown,
	extractMetadataFromHtml,
	extractReadableContent,
	formatMetadataBlock,
	isHtmlContentType,
} from "./utils";

const fetchUrlSchema = Type.Object(
	{
		url: Type.String({ description: "URL to fetch." }),
		raw: Type.Optional(
			Type.Boolean({
				description: "Return the raw response body without extraction (default: false).",
			}),
		),
		format: Type.Optional(
			Type.Union([Type.Literal("markdown"), Type.Literal("html")], {
				description: "Output format for extracted main content (default: markdown).",
			}),
		),
	},
	{ additionalProperties: false },
);

type FetchUrlParams = Static<typeof fetchUrlSchema>;

type FetchUrlDetails = {
	url: string;
	status: number;
	contentType?: string;
	format: "markdown" | "html" | "raw";
	metadata?: ReturnType<typeof extractMetadataFromHtml>;
	usedFallback?: boolean;
	truncation?: ReturnType<typeof truncateHead>;
	fullOutputPath?: string;
};

async function writeTempOutput(content: string): Promise<string> {
	const id = randomBytes(8).toString("hex");
	const path = join(tmpdir(), `pi-fetch-url-${id}.log`);
	await writeFile(path, content, "utf8");
	return path;
}

function extractText(result: { content?: Array<{ type: string; text?: string }> }): string {
	if (!result.content) return "";
	return result.content
		.map((block) => (block.type === "text" ? block.text ?? "" : ""))
		.join("\n")
		.trim();
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "fetch_url",
		label: "fetch_url",
		description:
			"Fetch a URL and return the main content. Defaults to extracted markdown with metadata, with options to return HTML or raw content.",
		parameters: fetchUrlSchema,
		renderCall: (args, theme) => {
			const format = args.raw ? "raw" : args.format ?? "markdown";
			const url = args.url ?? "(missing url)";
			const toolTitle = theme.fg("toolTitle", theme.bold("fetch_url"));
			const lines = [
				`${toolTitle} ${theme.fg("accent", url)}`,
				theme.fg("muted", `Format: ${format}`),
			];
			return new Text(lines.join("\n"), 0, 0);
		},
		renderResult: (result, { isPartial }, theme) => {
			if (isPartial) {
				return new Text(theme.fg("muted", "Fetching..."), 0, 0);
			}

			const text = extractText(result) || "(no output)";
			return new Text(text, 0, 0);
		},
		async execute(_toolCallId, params: FetchUrlParams, signal) {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}

			let parsedUrl: URL;
			try {
				parsedUrl = new URL(params.url);
			} catch {
				throw new Error("fetch_url requires a valid URL");
			}

			if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
				throw new Error("fetch_url requires an http or https URL");
			}

			const response = await fetch(parsedUrl.toString(), {
				signal,
				headers: {
					Accept: "text/markdown,text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5",
					"User-Agent": "pi-fetch-url/1.0 (+https://pi)",
				},
			});

			if (!response.ok) {
				throw new Error(`Request failed (${response.status} ${response.statusText})`);
			}

			const contentTypeHeader = response.headers.get("content-type");
			const contentType = contentTypeHeader?.split(";")[0]?.trim();
			const body = await response.text();

			const wantsRaw = params.raw ?? false;
			const isHtml = isHtmlContentType(contentType);
			const format = params.format ?? "markdown";

			let outputContent = body;
			let metadata: ReturnType<typeof extractMetadataFromHtml> = {};
			let usedFallback: boolean | undefined;
			let effectiveFormat: FetchUrlDetails["format"] = "raw";

			if (!wantsRaw && isHtml) {
				const extracted = extractReadableContent(body, parsedUrl.toString());
				metadata = extracted.metadata;
				usedFallback = extracted.usedFallback;

				const htmlContent = extracted.html || body;
				if (format === "html") {
					outputContent = htmlContent;
					effectiveFormat = "html";
				} else {
					outputContent = convertHtmlToMarkdown(htmlContent);
					effectiveFormat = "markdown";
				}
			} else if (isHtml) {
				metadata = extractMetadataFromHtml(body, parsedUrl.toString());
				outputContent = body;
				effectiveFormat = "raw";
			} else {
				effectiveFormat = "raw";
			}

			const metadataBlock = formatMetadataBlock(metadata, {
				url: parsedUrl.toString(),
				contentType,
			});

			const fullOutput = outputContent
				? `${metadataBlock}\n\n${outputContent}`
				: metadataBlock;
			const truncation = truncateHead(fullOutput, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});

			let outputText = truncation.content || "(no output)";
			const details: FetchUrlDetails = {
				url: parsedUrl.toString(),
				status: response.status,
				contentType: contentType ?? undefined,
				format: effectiveFormat,
				metadata,
				usedFallback,
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
