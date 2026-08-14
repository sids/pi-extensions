# Changelog

## Unreleased

- Accepted file and folder paths in `/annotate` while retaining last-message annotation with no arguments.
- Added tailnet-only HTTPS publishing and QR codes through global `PLANNOTATOR_TAILSCALE` mode.

## 0.1.0

- Added `/annotate` to review the latest assistant message in Plannotator.
- Sent submitted annotation feedback directly to the agent.
- Rendered feedback readably while preserving the original Markdown sent to the agent.
- Kept Pi responsive while annotation is open and prevented delivery after the session or conversation branch moves.
- Stopped active annotation browser sessions during Pi session shutdown.
- Styled browser URLs and supported explicit Tailscale remote URLs.
