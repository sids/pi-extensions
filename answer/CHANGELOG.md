# Changelog

## 0.1.9 - 2026-08-07

- Routed extraction calls through Pi's model runtime for Pi 0.84 provider and authentication compatibility.

## 0.1.8 - 2026-08-06

- Raised the minimum Pi peer version to 0.83.0.
- Forwarded provider-scoped environment values for question extraction model calls.
- Adopted Pi’s `contentText()` helper for assistant text extraction.

## 0.1.7 - 2026-07-29

- Switched the preferred question extraction model to GPT-5.6 Luna.
- Limited interactive question collection to TUI sessions.
- Read project-level answer settings only for trusted projects.
- Raised the minimum Pi peer version to 0.80.6.

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
