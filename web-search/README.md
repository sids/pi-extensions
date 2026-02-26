# Web Search (Brave) Extension

Adds a `web_search` tool backed by the Brave Search API. Results include titles, URLs, snippets, and age when available. This extension does not fetch page content.

## Setup (recommended)

1. Get an API key from https://api-dashboard.search.brave.com.
2. In pi, run:

```
/web-search-setup
```

Paste your primary API key when prompted. You can optionally add a fallback key (used when the primary key hits rate limits).

### Setup commands

- `/web-search-setup` — prompts for primary key, then optional fallback
- `/web-search-setup primary` — set/replace primary only
- `/web-search-setup fallback` — set/replace fallback only

## Advanced setup (manual secrets)

You can also set keys directly in `~/.pi/agent/auth.json`:

```json
{
  "brave-search": { "type": "api_key", "key": "PRIMARY_KEY" },
  "brave-search-fallback": { "type": "api_key", "key": "FALLBACK_KEY" }
}
```

If `auth.json` already has entries, merge these keys instead of overwriting the file.

## Install locally

```bash
ln -sfn /path/to/pi-extensions/web-search ~/.pi/agent/extensions/web-search
```

Then in pi:

```
/reload
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
