# Changelog

## 0.1.6 - 2026-04-23

- Replaced the custom editor autocomplete integration with stacked `ctx.ui.addAutocompleteProvider(...)` providers.
- Dropped the shared editor-composition dependency and now require Pi 0.69 or newer.

## 0.1.5 - 2026-04-04

- Updated session lifecycle handling for pi 0.65.0 by rebuilding editor state from `session_start`.

## 0.1.4 - 2026-03-28

- Forwarded autocomplete request options to the base provider so `/` autocomplete no longer crashes on current pi builds.

## 0.1.3 - 2026-03-28

- Updated compatibility with current pi APIs.
- Composed the mention editor with other session editor extensions.
