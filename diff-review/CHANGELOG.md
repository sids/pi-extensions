# Changelog

## 0.1.2 - 2026-08-07

- Migrated local dependency locking from Bun to the repository pnpm workspace.

## 0.1.1 - 2026-08-06

- Raised the minimum Pi peer version to 0.83.0.

## 0.1.0

- Add `/diff-review` for opening a local browser diff review.
- Offer cmux Surface, cmux Pane, Glimpse, and Default Browser open targets when available.
- Render diffs with `@pierre/diffs` and the sidebar file tree with `@pierre/trees`.
- Send line, file, and overall review comments back to the pi editor.
