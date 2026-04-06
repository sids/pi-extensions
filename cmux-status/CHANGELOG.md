# Changelog

## 0.1.2 - 2026-04-04

- Updated session lifecycle handling for pi 0.65.0 by relying on `session_start` instead of removed session transition events.

## 0.1.1 - 2026-03-28

- Switched to socket transport with CLI fallback for faster status updates.
- Isolated status ownership and serialized update writes.
- Cleared named status output when an agent finishes.
