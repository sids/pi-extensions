# AGENTS

## Project overview

This repository contains the **answer**, **fetch-url**, **web-search**, **status**, **plan-md**, **task-subagents**, **review**, and **mention-skills** pi extensions.

## Key files

- `package.json`: npm workspace manifest for local linking of `shared`, `answer`, and `plan-md`
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
- `plan-md/index.ts`: Extension entry point
- `plan-md/flow.ts`: `/plan-md` command flow
- `plan-md/plan-files.ts`: Plan file path + movement helpers
- `plan-md/request-user-input.ts`: `request_user_input` tool behavior
- `plan-md/README.md`: Usage docs
- `plan-md/tests/*.test.ts`: Unit tests
- `task-subagents/index.ts`: Extension entry point
- `task-subagents/subagents.ts`: `subagents` / `steer_subagent` tool behavior
- `task-subagents/utils.ts`: Shared helpers
- `task-subagents/README.md`: Usage docs
- `task-subagents/tests/*.test.ts`: Unit tests
- `review/index.ts`: Extension entry point
- `review/flow.ts`: `/review` start/end orchestration
- `review/state.ts`: Review mode state + tool gating/banner
- `review/comments.ts`: `add_review_comment` tool behavior + persistence
- `review/target-selector.ts`: Target parsing/selection + PR checkout flow
- `review/prompts.ts`: Review rubric + target prompt builders
- `review/triage-tui.ts`: End-of-review triage UI + state helpers
- `review/utils.ts`: Shared parsing/normalization helpers
- `review/README.md`: Usage docs
- `review/tests/*.test.ts`: Unit tests
- `mention-skills/index.ts`: Extension entry point
- `mention-skills/utils.ts`: Skill discovery, mention detection, replacement, and autocomplete provider helpers
- `mention-skills/README.md`: Usage docs
- `mention-skills/tests/utils.test.ts`: Unit tests
- `shared/qna-tui.ts`: Shared Q&A TUI component
- `shared/package.json`: npm package manifest for `@siddr/pi-shared-qna`
- `shared/README.md`: shared package usage notes

## Adding new extensions

1. Create a new directory under the repo root (e.g., `my-extension/`).
2. Add an `index.ts` entry point.
3. Document usage in `my-extension/README.md`.
4. Add tests under `my-extension/tests/` (when applicable).

## Development notes

- Always add/update tests when making changes.
- Run `npm install` at repo root before testing or local extension runs. This links workspace dependencies (notably `@siddr/pi-shared-qna` used by `answer` and `plan-md`).
- Always run tests after making changes.
- Run tests with:
  ```bash
  bun test answer/tests/utils.test.ts
  bun test answer/tests/qna-adapter.test.ts
  bun test fetch-url/tests/utils.test.ts
  bun test web-search/tests/utils.test.ts
  bun test status/tests/utils.test.ts
  bun test plan-md/tests/utils.test.ts
  bun test plan-md/tests/state.test.ts
  bun test plan-md/tests/plan-files.test.ts
  bun test plan-md/tests/flow.test.ts
  bun test plan-md/tests/request-user-input.test.ts
  bun test plan-md/tests/prompts.test.ts
  bun test task-subagents/tests/*.test.ts
  bun test review/tests/utils.test.ts
  bun test review/tests/state.test.ts
  bun test review/tests/comments.test.ts
  bun test review/tests/flow.test.ts
  bun test review/tests/triage-tui.test.ts
  bun test review/tests/target-selector.test.ts
  bun test mention-skills/tests/utils.test.ts
  ```
- To load an extension locally, symlink its directory into `~/.pi/agent/extensions/<name>` and run `/reload` in pi.
