# Changelog

## 0.1.7 - 2026-08-03

- Added an optional 24-hour prompt cache retention setting for supported official OpenAI APIs.
- Emitted effective cache-retention details so cache-aware extensions can track the configured window.

## 0.1.6 - 2026-07-29

- Applied fast mode to any `gpt-` model on official OpenAI providers instead of maintaining a model allowlist.
- Prevented GitHub Copilot, local servers, and custom proxies from receiving OpenAI Priority parameters based only on their serializer type.
- Removed `supportedModels` from persisted configuration; older values are ignored.
- Limited the interactive settings screen to TUI sessions.
- Read project-level settings only for trusted projects.
- Raised the minimum Pi peer version to 0.80.6.

## 0.1.5 - 2026-05-15

- Updated package metadata for the pnpm workspace migration.

## 0.1.4 - 2026-05-15

- Migrated runtime imports and peer dependencies to the `@earendil-works/*` Pi 0.74 package scope.

## 0.1.3 - 2026-04-23

- Resolved config paths from the active session cwd instead of falling back to `process.cwd()`.
- Bound the published Pi peer dependency to post-0.65 releases.

## 0.1.2 - 2026-04-04

- Updated session lifecycle handling for pi 0.65.0 by refreshing config from `session_start`.

## 0.1.1 - 2026-03-28

- Added status widget support for OpenAI fast mode and verbosity settings.
- Stored global settings in the agent root.
