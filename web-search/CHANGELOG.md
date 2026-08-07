# Changelog

## 0.1.9 - 2026-08-07

- Disabled strict sampling for optional search parameters to keep `web_search` compatible with OpenAI Codex tool schemas.

## 0.1.8 - 2026-08-06

- Raised the minimum Pi peer version to 0.83.0.
- Enabled preferred strict JSON-schema sampling for the `web_search` tool.

## 0.1.7 - 2026-07-29

- Registered primary and fallback Brave Search authentication providers with Pi's `/login` flow.
- Added setup commands that prefill the corresponding Brave Search login command.
- Added tool guidance for choosing `web_search` when current or external information is needed.
- Raised the minimum Pi peer version to 0.80.6.

## 0.1.6 - 2026-05-15

- Updated package metadata for the pnpm workspace migration.

## 0.1.5 - 2026-05-15

- Migrated runtime imports and peer dependencies to the `@earendil-works/*` Pi 0.74 package scope.

## 0.1.4 - 2026-04-23

- Migrated tool schemas from `@sinclair/typebox` to `typebox` for Pi 0.69 compatibility.
- Bound the published Pi peer dependency to post-0.65 releases.

## 0.1.3 - 2026-03-28

- Added a `promptSnippet` so `web_search` stays visible in pi's default tool prompt.

## 0.1.2 - 2026-03-28

- Updated compatibility with current pi APIs.
