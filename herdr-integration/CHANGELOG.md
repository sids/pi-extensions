# Changelog

## 0.1.0 - 2026-08-07

- Added automatic Herdr blocked-state reporting when the assistant requests required input.
- Added system-prompt guidance for the `:input_needed:` sentinel.
- Added support for shared `pi:waiting-for-user-input` events from interactive extensions.
- Hide complete and partially streamed sentinels from Pi's Markdown rendering while retaining the final marker in session data.
- Limit prompt changes and blocked reporting to Herdr root UI sessions.
- Added blocked-state restoration when resuming or reloading an unanswered session.
