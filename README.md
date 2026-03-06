# pi-extensions

> ⚠️ **Warning:** The code in this repo is complete Vibeslop, written by clankers and _not_ reviewed by me. Use at your own risk. I do use all these extensions all the time.

A collection of pi extensions. Each extension lives in its own directory with its own README.

## Repository layout

- [`plan-md/`](plan-md/) – Branch-based planning workflow with subagent research and persisted plan files
- [`review/`](review/) – Interactive review mode with target selection, structured findings capture, and triage
- [`answer/`](answer/) – Interactive Q&A workflow for extracting questions and sending compiled answers
- [`mention-skills/`](mention-skills/) – `$skill-name` autocomplete with submit-time expansion to `SKILL.md` paths
- [`prompt-thinking/`](prompt-thinking/) – `^thinking-level` autocomplete with single-prompt thinking overrides
- [`fetch-url/`](fetch-url/) – URL fetch tool with main-content extraction and markdown/html/raw output
- [`web-search/`](web-search/) – Brave Search `web_search` tool for single or multi-query result sets
- [`status/`](status/) – Live status line and terminal title indicators for model, repo, timing, and PR context

## Documentation

See each extension’s README for setup and usage. Developer notes live in `AGENTS.md`.

## Local development and publishing notes

- Keep pi runtime packages in each extension's `peerDependencies` (`@mariozechner/pi-*`, `@sinclair/typebox` where needed). This is what published npm packages rely on.
- Keep the same runtime packages in the workspace root `devDependencies` so local symlinked extensions resolve the same imports during development.
- Run `npm run check:peer-runtime` before publishing. This verifies that all extension `peerDependencies` are represented in root `devDependencies`.
- Run `npm install` at the repo root after pulling changes so workspace links and runtime deps are present.
