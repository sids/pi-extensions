# Changelog

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
