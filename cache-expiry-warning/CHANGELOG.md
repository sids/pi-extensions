# Changelog

## 0.1.0 - 2026-08-02

- Added an above-editor warning when an observed prompt cache expires between turns.
- Added support for Pi's 5-minute default, 1-hour long retention, and 24-hour long retention.
- Detect cache configuration on the first request and avoid guessing expiry times for unknown provider TTLs.
- Count cache inactivity from the provider request so response and tool time do not delay the warning.
- Observe effective request retention reported by `openai-params` so OpenAI warnings use the configured 24-hour window regardless of extension load order.
