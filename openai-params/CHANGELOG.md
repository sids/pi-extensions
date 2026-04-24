# Changelog

## 0.1.3 - 2026-04-23

- Resolved config paths from the active session cwd instead of falling back to `process.cwd()`.
- Bound the published Pi peer dependency to post-0.65 releases.

## 0.1.2 - 2026-04-04

- Updated session lifecycle handling for pi 0.65.0 by refreshing config from `session_start`.

## 0.1.1 - 2026-03-28

- Added status widget support for OpenAI fast mode and verbosity settings.
- Stored global settings in the agent root.
