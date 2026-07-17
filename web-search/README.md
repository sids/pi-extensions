# Web Search (Brave) Extension

Adds a `web_search` tool backed by the Brave Search API. Results include titles, URLs, snippets, and age when available. This extension does not fetch page content.

## Setup (recommended)

1. Get an API key from https://api-dashboard.search.brave.com.
2. In pi, run `/login brave-search` and paste the API key.
3. Optional: run `/login brave-search-fallback` to add a fallback key used when the primary key hits rate limits.

`/web-search-setup`, `/web-search-setup primary`, and `/web-search-setup fallback` prefill the corresponding `/login` command for convenience.

## Advanced setup (environment or manual secrets)

You can provide keys through environment variables:

```bash
export BRAVE_SEARCH_API_KEY="PRIMARY_KEY"
export BRAVE_SEARCH_FALLBACK_API_KEY="FALLBACK_KEY"
```

You can also set keys directly in `~/.pi/agent/auth.json`:

```json
{
  "brave-search": { "type": "api_key", "key": "PRIMARY_KEY" },
  "brave-search-fallback": { "type": "api_key", "key": "FALLBACK_KEY" }
}
```

If `auth.json` already has entries, merge these keys instead of overwriting the file.

## Install

```bash
pi install npm:@siddr/pi-web-search
```

## Tool

### `web_search`

Parameters:
- `query` (string) — single search query
- `queries` (string[]) — multiple search queries
- `count` (number, optional) — results **per query** (max 20)

Defaults:
- Single query: `count = 10`
- Multiple queries: `count = 5` unless overridden

Behavior:
- Multiple queries return grouped results per query.
- Use `Ctrl+O` to expand tool output and show snippets.
- Output is truncated to 2000 lines or 50KB. When truncated, the full output is saved to a temp file and its path is included in the tool output.

### Example prompts

```
Search for "brave search api" and summarize the top results.
Search for the following: queries=["pi coding agent extensions", "brave search api pricing"].
Search for "rust async runtime" with count=8.
```
