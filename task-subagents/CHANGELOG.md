# Changelog

## 0.1.3 - 2026-03-28

- Added `promptSnippet` metadata for `subagents` and `steer_subagent` so they stay visible in pi's default tool prompt.
- Switched validation and launch-cancellation failures to thrown errors so pi marks those tool calls correctly.

## 0.1.2 - 2026-03-28

- Required explicit subagent requests before launching child sessions.
- Added session-aware subagent status updates.
- Used the accent color for the inspector tab.
