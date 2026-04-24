# Changelog

## 0.1.6 - 2026-04-23

- Replaced the custom editor autocomplete integration with stacked `ctx.ui.addAutocompleteProvider(...)` providers.
- Prefer the live current thinking level at the top of bare `^` suggestions and now require Pi 0.69 or newer.

## 0.1.5 - 2026-04-04

- Updated session lifecycle handling for pi 0.65.0 by resetting editor state from `session_start`.

## 0.1.4 - 2026-03-28

- Forwarded autocomplete request options to the base provider so `/` autocomplete remains compatible with current pi builds.

## 0.1.3 - 2026-03-28

- Composed the thinking editor with other session editor extensions.
