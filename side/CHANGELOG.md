# Changelog

## 0.1.2 - 2026-08-07

- Raised the minimum Pi peer version to 0.84.0.
- Routed parent summaries through Pi's model runtime and updated child runtime authentication and catalog refresh handling for Pi 0.84.
- Limited strict sampling to parent bridge tools whose schemas require every parameter.

## 0.1.1 - 2026-08-06

- Raised the minimum Pi peer version to 0.83.0.
- Migrated the child agent to Pi’s `ModelRuntime`, mirrored parent provider registrations, and preserved runtime-only authentication such as `--api-key`.
- Made model cycling and direct selection honor the parent scoped-model list and pinned thinking levels.
- Typed child lifecycle events, supported pending partial messages, and enabled preferred strict sampling for parent bridge tools.

