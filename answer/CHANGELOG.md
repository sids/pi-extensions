# Changelog

## 0.1.6 - 2026-05-15

- Updated package metadata for the pnpm workspace migration.
- Linked the shared Q&A package through the local pnpm workspace.

## 0.1.5 - 2026-05-15

- Migrated runtime imports and peer dependencies to the `@earendil-works/*` Pi 0.74 package scope.

## 0.1.4 - 2026-04-24

- Updated the default question extraction model preference order to prefer current OpenAI Codex and GitHub Copilot mini/fast models before Haiku fallbacks.

## 0.1.3 - 2026-04-23

- Read global settings from Pi's configured agent dir instead of hardcoding `~/.pi/agent`.
- Added coverage for answer settings path resolution.

## 0.1.2 - 2026-03-28

- Updated compatibility with current pi APIs.
- Expanded coverage for raw custom request answers.
