# Changelog

## 0.1.15 - 2026-08-07

- Routed review summary calls through Pi's model runtime for Pi 0.84 provider and authentication compatibility.
- Disabled strict sampling for review findings because source references and line-range ends are intentionally optional.

## 0.1.14 - 2026-08-06

- Raised the minimum Pi peer version to 0.83.0.
- Applied Pi’s configured output padding to custom review messages.
- Enabled preferred strict sampling for review findings and forwarded provider-scoped environment values for summary calls.

## 0.1.13 - 2026-08-03

- Added timed defaults for starting reviews from an empty branch and selecting uncommitted changes.
- Opened review triage automatically when the reviewing agent settles, with a countdown to accept all comments and return to the original branch.
- Added recovery guidance when automatic review exit cannot resume after a restart or extension reload.
- Added `Ctrl+Alt+R` to start a review from an empty editor.

## 0.1.12 - 2026-07-29

- Added a 10-second auto-submit countdown for review start and follow-up prompts, with controls to edit or cancel submission.
- Propagated cancellation through review prompt submission and change-summary generation.
- Restricted active tools while review mode is enabled and restored the previous tool set on exit.
- Reported loaded context files and skills when review mode starts.
- Added explicit guidance for recording findings with `add_review_comment`.
- Limited review mode to TUI sessions and loaded project review guidance only for trusted projects.
- Raised the minimum Pi peer version to 0.80.6.

## 0.1.11 - 2026-05-15

- Updated package metadata for the pnpm workspace migration.

## 0.1.10 - 2026-05-15

- Migrated runtime imports and peer dependencies to the `@earendil-works/*` Pi 0.74 package scope.

## 0.1.9 - 2026-04-27

- Prefill PR review exits with a GitHub CLI inline-comment instruction.
- Preserve repo-qualified pull request URLs when preparing inline-comment follow-ups.

## 0.1.8 - 2026-04-26

- Added quoted argument parsing for direct review commands, including paths, commit titles, and custom instructions.
- Added clearer GitHub CLI install/auth checks before pull request reviews.
- Improved review target labels in review-mode prompts, triage, and summaries.

## 0.1.7 - 2026-04-24

- Added session-history based change summaries for empty-branch reviews of uncommitted changes.
- Display change summaries after review instructions with a collapsed preview that can be expanded.
- Generate change summary output as structured JSON before rendering it with a consistent title.

## 0.1.6 - 2026-04-23

- Migrated tool schemas from `@sinclair/typebox` to `typebox` for Pi 0.69 compatibility.
- Bound the published Pi peer dependency to post-0.65 releases.

## 0.1.5 - 2026-04-07

- Hide stale review instruction messages after exit and only show the current review run's prompt.

## 0.1.4 - 2026-04-04

- Updated session lifecycle handling for pi 0.65.0 by restoring review mode state from `session_start`.

## 0.1.3 - 2026-03-28

- Added a `promptSnippet` for `add_review_comment` so it stays visible in pi's default tool prompt.
- Switched inactive-mode and validation failures in `add_review_comment` to thrown errors so pi marks those tool calls correctly.

## 0.1.2 - 2026-03-28

- Surfaced saved user notes in review summaries.
- Updated compatibility with current pi APIs.
