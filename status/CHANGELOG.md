# Changelog

## 0.1.11 - 2026-08-06

- Raised the minimum Pi peer version to 0.83.0.
- Measured one continuous agent interval through retries, compaction, and queued continuations until `agent_settled`.

## 0.1.10 - 2026-08-03

- Moved session, repository, and pull-request context above the editor while keeping model, thinking, context usage, and timing below it.
- Simplified model and context labels and refreshed repository details independently from prompt timing.
- Displayed active 24-hour OpenAI cache retention from `openai-params`.

## 0.1.9 - 2026-07-29

- Added status coloring for the `max` thinking level.
- Displayed active plan and review mode tools in the status widget.
- Refreshed the widget when the Pi session name changes.
- Raised the minimum Pi peer version to 0.80.6.

## 0.1.8 - 2026-05-15

- Updated package metadata for the pnpm workspace migration.

## 0.1.7 - 2026-05-15

- Migrated runtime imports and peer dependencies to the `@earendil-works/*` Pi 0.74 package scope.

## 0.1.6 - 2026-04-23

- Bound the published Pi peer dependency to post-0.65 releases that match the current session lifecycle hooks.

## 0.1.5 - 2026-04-06

- Renamed the prompt-run timer to `agent`, renamed cumulative turn timing to `turn total`, and reset timers when a new session starts.

## 0.1.4 - 2026-04-04

- Updated session lifecycle handling for pi 0.65.0 by refreshing widget state from `session_start`.

## 0.1.3 - 2026-03-28

- Added OpenAI fast mode and verbosity details to the status widget.
- Stopped updating the terminal title.
