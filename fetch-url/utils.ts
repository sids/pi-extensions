import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";

export const DEFAULT_MAIN_CONTENT_SELECTORS = [
	"article",
	"main",
	"[role=main]",
	".post",
	".article-body",
	".content",
	".post-content",
	".entry-content",
	"#content",
];

export const MIN_CONTENT_LENGTH = 200;

export type ExtractedMetadata = {
	title?: string;
	byline?: string;
	siteName?: string;
	publishedTime?: string;
	lang?: string;
};

export type ExtractedContent = {
	html: string;
	text: string;
	metadata: ExtractedMetadata;
	usedFallback: boolean;
};

const turndownService = new TurndownService({
	codeBlockStyle: "fenced",
	headingStyle: "atx",
});

function normalizeText(value: string | null | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function normalizeTextContent(value: string | null | undefined): string {
	return (value ?? "").replace(/\s+/g, " ").trim();
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | undefined {
	for (const value of values) {
		const normalized = normalizeText(value);
		if (normalized) {
			return normalized;
		}
	}
	return undefined;
}

function getMetaContent(
	document: Document,
	attribute: "name" | "property" | "itemprop",
	key: string,
): string | undefined {
	const selector = `meta[${attribute}="${key}"]`;
	const content = document.querySelector(selector)?.getAttribute("content");
	return normalizeText(content);
}

export function extractPublishedTime(document: Document): string | undefined {
	const metaKeys: Array<{ attribute: "name" | "property" | "itemprop"; key: string }> = [
		{ attribute: "property", key: "article:published_time" },
		{ attribute: "property", key: "og:published_time" },
		{ attribute: "name", key: "pubdate" },
		{ attribute: "name", key: "publishdate" },
		{ attribute: "name", key: "timestamp" },
		{ attribute: "name", key: "date" },
		{ attribute: "name", key: "datePublished" },
		{ attribute: "name", key: "dc.date" },
		{ attribute: "name", key: "dcterms.created" },
		{ attribute: "itemprop", key: "datePublished" },
	];

	for (const { attribute, key } of metaKeys) {
		const value = getMetaContent(document, attribute, key);
		if (value) {
			return value;
		}
	}

	const timeElement = document.querySelector("time[datetime]");
	return firstNonEmpty(timeElement?.getAttribute("datetime"), timeElement?.textContent);
}

export function extractMetadataFromDocument(document: Document): ExtractedMetadata {
	const title = firstNonEmpty(
		getMetaContent(document, "property", "og:title"),
		getMetaContent(document, "name", "twitter:title"),
		getMetaContent(document, "name", "title"),
		normalizeText(document.title),
	);

	const byline = firstNonEmpty(
		getMetaContent(document, "name", "author"),
		getMetaContent(document, "property", "article:author"),
		getMetaContent(document, "name", "parsely-author"),
		getMetaContent(document, "name", "sailthru.author"),
	);

	const siteName = firstNonEmpty(
		getMetaContent(document, "property", "og:site_name"),
		getMetaContent(document, "name", "application-name"),
	);

	const lang = firstNonEmpty(
		normalizeText(document.documentElement?.getAttribute("lang")),
		getMetaContent(document, "property", "og:locale"),
	);

	const publishedTime = extractPublishedTime(document);

	return {
		title,
		byline,
		siteName,
		publishedTime,
		lang,
	};
}

export function extractMetadataFromHtml(html: string, url: string): ExtractedMetadata {
	const dom = new JSDOM(html, { url });
	return extractMetadataFromDocument(dom.window.document);
}

export function pickBestContentNode(
	document: Document,
	selectors: string[] = DEFAULT_MAIN_CONTENT_SELECTORS,
): { html: string; text: string; selector: string } | null {
	let best: { html: string; text: string; length: number; selector: string } | null = null;

	for (const selector of selectors) {
		const elements = Array.from(document.querySelectorAll(selector));
		for (const element of elements) {
			const text = normalizeTextContent(element.textContent);
			const length = text.length;
			if (!text || length === 0) {
				continue;
			}
			if (!best || length > best.length) {
				best = {
					html: element.innerHTML.trim(),
					text,
					length,
					selector,
				};
			}
		}
	}

	if (best) {
		return { html: best.html, text: best.text, selector: best.selector };
	}

	const body = document.body;
	if (!body) {
		return null;
	}

	const bodyText = normalizeTextContent(body.textContent);
	if (!bodyText) {
		return null;
	}

	return {
		html: body.innerHTML.trim(),
		text: bodyText,
		selector: "body",
	};
}

export function extractReadableContent(html: string, url: string): ExtractedContent {
	const dom = new JSDOM(html, { url });
	const document = dom.window.document;
	const baseMetadata = extractMetadataFromDocument(document);

	let article: ReturnType<Readability["parse"]> | null = null;
	try {
		article = new Readability(document).parse();
	} catch {
		article = null;
	}

	const mergedMetadata: ExtractedMetadata = {
		title: normalizeText(article?.title) ?? baseMetadata.title,
		byline: normalizeText(article?.byline) ?? baseMetadata.byline,
		siteName: normalizeText(article?.siteName) ?? baseMetadata.siteName,
		publishedTime: baseMetadata.publishedTime,
		lang: normalizeText(article?.lang) ?? baseMetadata.lang,
	};

	const articleHtml = article?.content?.trim() ?? "";
	const articleText = normalizeTextContent(article?.textContent);

	if (articleHtml && articleText.length >= MIN_CONTENT_LENGTH) {
		return {
			html: articleHtml,
			text: articleText,
			metadata: mergedMetadata,
			usedFallback: false,
		};
	}

	const fallbackDocument = new JSDOM(html, { url }).window.document;
	const fallback = pickBestContentNode(fallbackDocument);

	if (fallback) {
		return {
			html: fallback.html,
			text: fallback.text,
			metadata: mergedMetadata,
			usedFallback: true,
		};
	}

	return {
		html: "",
		text: "",
		metadata: mergedMetadata,
		usedFallback: true,
	};
}

export function convertHtmlToMarkdown(html: string): string {
	return turndownService.turndown(html).trim();
}

export function formatMetadataBlock(
	metadata: ExtractedMetadata,
	options: { url: string; contentType?: string },
): string {
	const lines = [`URL: ${options.url}`];

	if (options.contentType) {
		lines.push(`Content-Type: ${options.contentType}`);
	}
	if (metadata.title) {
		lines.push(`Title: ${metadata.title}`);
	}
	if (metadata.byline) {
		lines.push(`Byline: ${metadata.byline}`);
	}
	if (metadata.siteName) {
		lines.push(`Site: ${metadata.siteName}`);
	}
	if (metadata.publishedTime) {
		lines.push(`Published: ${metadata.publishedTime}`);
	}
	if (metadata.lang) {
		lines.push(`Language: ${metadata.lang}`);
	}

	return lines.join("\n");
}

export function isHtmlContentType(contentType: string | null | undefined): boolean {
	if (!contentType) {
		return true;
	}
	const lowered = contentType.toLowerCase();
	return lowered.includes("text/html") || lowered.includes("application/xhtml+xml");
}
