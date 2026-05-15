# Changelog

## 0.1.7 - 2026-05-15

- Updated package metadata for the pnpm workspace migration.
- Linked the shared Q&A package through the local pnpm workspace.

## 0.1.6 - 2026-05-15

- Migrated runtime imports and peer dependencies to the `@earendil-works/*` Pi 0.74 package scope.
- Updated subagent thinking-level detection and tool preview rendering for the latest Pi runtime APIs.

## 0.1.5 - 2026-04-23

- Migrated tool schemas from `@sinclair/typebox` to `typebox` for Pi 0.69 compatibility.
- Replaced literal-union helper schemas with `StringEnum(...)` and bound the published Pi peer dependency to post-0.65 releases.

## 0.1.4 - 2026-03-30

- Added a 30s auto-launch countdown directly on the per-task subagent review screen, with visible time remaining and automatic launch when the timer expires.
- Made any review interaction stop the countdown permanently for that review, kept `Esc` as a quick way to stop only the countdown on the review screen, preserved `Ctrl+C` as full launch-review cancel, restored the final manual confirmation screen after interaction, and reset the countdown when newly merged tasks are appended.
- Fixed aborted launch reviews so cancelling the parent tool call closes the review cleanly and prevents delayed child subagent launches.

## 0.1.3 - 2026-03-28

- Added `promptSnippet` metadata for `subagents` and `steer_subagent` so they stay visible in pi's default tool prompt.
- Switched validation and launch-cancellation failures to thrown errors so pi marks those tool calls correctly.

## 0.1.2 - 2026-03-28

- Required explicit subagent requests before launching child sessions.
- Added session-aware subagent status updates.
- Used the accent color for the inspector tab.
