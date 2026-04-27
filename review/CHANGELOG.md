# Changelog

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
