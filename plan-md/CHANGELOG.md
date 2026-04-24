# Changelog

## 0.1.12 - 2026-04-23

- Migrated tool schemas from `@sinclair/typebox` to `typebox` for Pi 0.69 compatibility.
- Bound the published Pi peer dependency to post-0.65 releases.

## 0.1.11 - 2026-04-13

- Clarified when plan mode should discuss first, persist via `set_plan`, and summarize the saved plan.

## 0.1.10 - 2026-04-07

- Hide stale plan-mode instruction messages after exit and only show the current activation's prompt.

## 0.1.9 - 2026-04-04

- Updated session lifecycle handling for pi 0.65.0 by restoring plan mode state from `session_start`.

## 0.1.8 - 2026-03-28

- Removed the `request_user_input` question cap so plan mode can ask any number of questions.

## 0.1.7 - 2026-03-28

- Added `promptSnippet` metadata for `set_plan` and `request_user_input` so they stay visible in pi's default tool prompt.
- Switched plan-mode tool validation and cancellation failures to thrown errors so pi marks those tool calls correctly.

## 0.1.6 - 2026-03-28

- Restored branch state when plan mode exits.
- Split delegated subagent tooling out into the standalone `task-subagents` extension.
- Returned raw answers from custom request prompts.
- Limited plan prompt resubmission to entry and compaction.
- Added session-aware request input handling.
- Removed the `Alt+P` shortcut.
- Updated compatibility with current pi APIs.
