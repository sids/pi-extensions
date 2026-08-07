# Changelog

## Unreleased

- Replaced the bundled diff viewer and local server with Plannotator's browser code review.
- Removed the cmux and Glimpse launch picker; browser launching now follows Plannotator configuration.
- Styled printed review URLs as underlined accent text and added a Tailscale URL in explicit remote mode.
- Forced Git-backed targets to remain on Plannotator's Git provider in colocated repositories.
- Preserved staged and untracked files when reviewing an unborn Git repository.
- Sent requested-change browser review feedback directly to the agent instead of prefilling the editor.
- Closed approved reviews without sending a message to the agent.

## 0.1.2 - 2026-08-07

- Migrated local dependency locking from Bun to the repository pnpm workspace.

## 0.1.1 - 2026-08-06

- Raised the minimum Pi peer version to 0.83.0.

## 0.1.0

- Add `/diff-review` for opening a local browser diff review.
- Offer cmux Surface, cmux Pane, Glimpse, and Default Browser open targets when available.
- Render diffs with `@pierre/diffs` and the sidebar file tree with `@pierre/trees`.
- Send line, file, and overall review comments back to the pi editor.
