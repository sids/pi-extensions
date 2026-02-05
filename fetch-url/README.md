# Fetch URL Extension

Adds a `fetch_url` tool that fetches a URL and returns the main readable content. By default, it extracts the primary content and converts it to Markdown. You can request raw HTML or extracted HTML if needed. Metadata (title, author/byline, site name, published time when available) is included in the output header.

## Install locally

```bash
cd /path/to/pi-extensions/fetch-url
bun install
ln -sfn /path/to/pi-extensions/fetch-url ~/.pi/agent/extensions/fetch-url
```

Then in pi:

```
/reload
```

## Tool

### `fetch_url`

Parameters:
- `url` (string, required) — URL to fetch.
- `raw` (boolean, optional) — return raw response body (no extraction).
- `format` (`"markdown" | "html"`, optional) — format for extracted content (default: `markdown`).

Behavior:
- If `raw=true`, returns raw response body.
- If the response is HTML and `raw` is false, uses Mozilla Readability + fallback heuristics to extract the main content.
- If the response is not HTML, returns raw text/JSON as-is.
- Output is truncated to 2000 lines or 50KB. Full output is saved to a temp file when truncated.

### Example prompts

```
Fetch https://example.com/article and summarize it.
Fetch https://example.com/article with format="html".
Fetch https://example.com/article with raw=true.
```
