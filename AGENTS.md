# AGENTS

## Project overview

This repository contains the **answer**, **fetch-url**, **web-search**, **status**, and **plan-mode** pi extensions.

## Key files

- `answer/index.ts`: Extension entry point
- `answer/qna-adapter.ts`: Draft state + compiled answer helpers
- `answer/utils.ts`: Shared helpers and settings parsing
- `answer/README.md`: Usage/config docs
- `answer/tests/utils.test.ts`: Unit tests
- `answer/tests/qna-adapter.test.ts`: Unit tests
- `fetch-url/index.ts`: Extension entry point
- `fetch-url/utils.ts`: Shared helpers
- `fetch-url/README.md`: Usage/config docs
- `fetch-url/tests/utils.test.ts`: Unit tests
- `web-search/index.ts`: Extension entry point
- `web-search/utils.ts`: Shared helpers
- `web-search/README.md`: Usage/config docs
- `web-search/tests/utils.test.ts`: Unit tests
- `status/index.ts`: Extension entry point
- `status/utils.ts`: Shared helpers
- `status/README.md`: Usage/config docs
- `status/tests/utils.test.ts`: Unit tests
- `plan-mode/index.ts`: Extension entry point
- `plan-mode/flow.ts`: `/plan-mode` command flow
- `plan-mode/plan-files.ts`: Plan file path + movement helpers
- `plan-mode/request-user-input.ts`: `request_user_input` tool behavior
- `plan-mode/subagents.ts`: `subagents` / `steer_subagent` tool behavior
- `plan-mode/README.md`: Usage docs
- `plan-mode/tests/*.test.ts`: Unit tests
- `shared/qna-tui.ts`: Shared Q&A TUI component

## Adding new extensions

1. Create a new directory under the repo root (e.g., `my-extension/`).
2. Add an `index.ts` entry point.
3. Document usage in `my-extension/README.md`.
4. Add tests under `my-extension/tests/` (when applicable).

## Development notes

- Always add/update tests when making changes.
- Always run tests after making changes.
- Run tests with:
  ```bash
  bun test answer/tests/utils.test.ts
  bun test answer/tests/qna-adapter.test.ts
  bun test fetch-url/tests/utils.test.ts
  bun test web-search/tests/utils.test.ts
  bun test status/tests/utils.test.ts
  bun test plan-mode/tests/utils.test.ts
  bun test plan-mode/tests/state.test.ts
  bun test plan-mode/tests/plan-files.test.ts
  bun test plan-mode/tests/flow.test.ts
  bun test plan-mode/tests/request-user-input.test.ts
  bun test plan-mode/tests/subagents.test.ts
  ```
- To load an extension locally, symlink its directory into `~/.pi/agent/extensions/<name>` and run `/reload` in pi.
