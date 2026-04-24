# Changelog

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
