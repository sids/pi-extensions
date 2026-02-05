import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import {
	extractMetadataFromDocument,
	extractPublishedTime,
	formatMetadataBlock,
	pickBestContentNode,
} from "../utils";

describe("extractMetadataFromDocument", () => {
	test("extracts metadata from standard meta tags", () => {
		const html = `<!doctype html>
		<html lang="en">
			<head>
				<title>Doc Title</title>
				<meta property="og:title" content="OG Title" />
				<meta property="og:site_name" content="Example Site" />
				<meta name="author" content="Ada Lovelace" />
				<meta property="article:published_time" content="2025-01-01T10:00:00Z" />
			</head>
			<body></body>
		</html>`;

		const document = new JSDOM(html).window.document;
		const metadata = extractMetadataFromDocument(document);

		expect(metadata.title).toBe("OG Title");
		expect(metadata.byline).toBe("Ada Lovelace");
		expect(metadata.siteName).toBe("Example Site");
		expect(metadata.publishedTime).toBe("2025-01-01T10:00:00Z");
		expect(metadata.lang).toBe("en");
	});
});

describe("extractPublishedTime", () => {
	test("falls back to time elements", () => {
		const html = `<!doctype html>
		<html>
			<head></head>
			<body>
				<time datetime="2024-12-24">December 24, 2024</time>
			</body>
		</html>`;
		const document = new JSDOM(html).window.document;
		expect(extractPublishedTime(document)).toBe("2024-12-24");
	});
});

describe("pickBestContentNode", () => {
	test("chooses the most substantial content block", () => {
		const html = `<!doctype html>
		<html>
			<body>
				<nav>Menu</nav>
				<article>Short.</article>
				<main>
					<p>This is the main content with more text than the article.</p>
					<p>Another sentence to make it longer.</p>
				</main>
			</body>
		</html>`;

		const document = new JSDOM(html).window.document;
		const selected = pickBestContentNode(document);

		expect(selected?.selector).toBe("main");
		expect(selected?.text).toContain("main content");
	});
});

describe("formatMetadataBlock", () => {
	test("renders metadata lines", () => {
		const block = formatMetadataBlock(
			{
				title: "Article Title",
				byline: "Author Name",
				siteName: "Site",
				publishedTime: "2024-10-01",
				lang: "en",
			},
			{ url: "https://example.com", contentType: "text/html" },
		);

		expect(block).toContain("URL: https://example.com");
		expect(block).toContain("Content-Type: text/html");
		expect(block).toContain("Title: Article Title");
		expect(block).toContain("Byline: Author Name");
		expect(block).toContain("Site: Site");
		expect(block).toContain("Published: 2024-10-01");
		expect(block).toContain("Language: en");
	});
});
