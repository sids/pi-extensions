# pi-extensions

> ⚠️ **Warning:** The code in this repo is complete Vibeslop, written by clankers and _not_ reviewed by me. Use at your own risk. I do use all these extensions all the time.

A collection of pi extensions. Each extension lives in its own directory with its own README.

## Repository layout

- [`plan-md/`](plan-md/) – Branch-based planning workflow with persisted plan files
- [`task-subagents/`](task-subagents/) – Standalone `subagents` / `steer_subagent` delegation tools with recursion disabled in spawned child sessions
- [`diff-cmux/`](diff-cmux/) – cmux browser diff review with continuous changed-file streaming, grouped sidebar navigation, and send-to-editor comments
- [`review/`](review/) – Interactive review mode with target selection, structured findings capture, and triage
- [`answer/`](answer/) – Interactive Q&A workflow for extracting questions and sending compiled answers
- [`mention-skills/`](mention-skills/) – `$skill-name` autocomplete with submit-time expansion to `SKILL.md` paths
- [`prompt-save/`](prompt-save/) – Session-wide saved prompt picker with save, restore, copy, and delete shortcuts
- [`prompt-thinking/`](prompt-thinking/) – `^thinking-level` autocomplete with single-prompt thinking overrides
- [`openai-params/`](openai-params/) – OpenAI settings UI for fast mode and verbosity request parameters
- [`fetch-url/`](fetch-url/) – URL fetch tool with main-content extraction and markdown/html/raw output
- [`web-search/`](web-search/) – Brave Search `web_search` tool for single or multi-query result sets
- [`status/`](status/) – Live status widget for model, repo, timing, and PR context
- [`tool-display/`](tool-display/) – Compact built-in tool rendering overrides for `read`, `write`, `edit`, `bash`, `grep`, `find`, and `ls`

## Documentation

See each extension’s README for setup and usage. Developer notes live in `AGENTS.md`.

## Local development and publishing notes

- Keep pi runtime packages in each extension's `peerDependencies` (`@mariozechner/pi-*`, `typebox` where needed). This is what published npm packages rely on.
- Keep the same runtime packages in the workspace root `devDependencies` so local symlinked extensions resolve the same imports during development.
- Run `npm run check:peer-runtime` before publishing. This verifies that all extension `peerDependencies` are represented in root `devDependencies`.
- Run `npm run check:package-boundaries` before publishing. This verifies that packaged runtime source files stay within their package boundaries.
- Run `npm install` at the repo root after pulling changes so workspace links and runtime deps are present.
