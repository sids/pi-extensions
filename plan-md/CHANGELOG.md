# Changelog

## Unreleased

- Opened each saved plan in Plannotator after the model turn completes, keeping the final response above the review URL.
- Exited plan mode directly on the current planning branch after browser approval.
- Preserved approval notes in the implementation prompt when plan mode exits.
- Styled printed review URLs as underlined accent text and added a Tailscale URL in explicit remote mode.
- Displayed requested plan changes persistently in the Pi transcript.

## 0.1.17 - 2026-08-07

- Disabled strict sampling for `request_user_input` because question options are intentionally optional, while retaining strict sampling for `set_plan`.

## 0.1.16 - 2026-08-06

- Raised the minimum Pi peer version to 0.83.0.
- Applied Pi’s configured output padding to custom plan messages.
- Enabled preferred strict tool sampling and serialized interactive `request_user_input` calls.

## 0.1.15 - 2026-07-29

- Avoided persisting plans for informational or advice-only requests.
- Restricted active tools while plan mode is enabled and restored the previous tool set on exit.
- Added tool guidance for requesting user input during planning.
- Reported loaded context files and skills when plan mode starts.
- Limited interactive planning operations and confirmations to TUI sessions.
- Resolved prompt files from Pi's configured agent directory.
- Raised the minimum Pi peer version to 0.80.6.

## 0.1.14 - 2026-05-15

- Updated package metadata for the pnpm workspace migration.
- Linked the shared Q&A package through the local pnpm workspace.

## 0.1.13 - 2026-05-15

- Migrated runtime imports and peer dependencies to the `@earendil-works/*` Pi 0.74 package scope.

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
