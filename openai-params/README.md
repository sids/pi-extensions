# openai-params

Combined OpenAI fast-mode and verbosity settings for pi.

## What it does

This extension adds `/openai-params`, which opens a small settings screen for:

- `Ctrl+S` saves
- `Esc` cancels

Use the list to:

- toggling fast mode
- setting verbosity to `low`, `medium`, `high`, or the default unset state

When enabled, it patches provider requests right before send:

- fast mode → `service_tier=priority`
- verbosity → `text.verbosity=<level>`

## Behavior

- Fast mode is only applied to configured supported models.
- Default supported models are:
  - `openai/gpt-5.4`
  - `openai-codex/gpt-5.4`
- Verbosity is applied only to OpenAI Responses-family APIs:
  - `openai-responses`
  - `openai-codex-responses`
  - `azure-openai-responses`
- The default verbosity setting is unset, so the extension does not send any `text.verbosity` field unless you choose one.

## Config

Config uses the same project-over-global pattern as the fast-mode package:

- project: `.pi/extensions/openai-params.json`
- global: `~/.pi/agent/openai-params.json`

If neither file exists, the extension creates the global file on first run.

Default config:

```json
{
  "fast": false,
  "verbosity": null,
  "supportedModels": [
    "openai/gpt-5.4",
    "openai-codex/gpt-5.4"
  ]
}
```

## Notes

This extension combines the behavior of:

- `@benvargas/pi-openai-fast` for `service_tier=priority`
- `pi-verbosity-control` for `text.verbosity`

based on OpenAI GPT-5 / Responses API parameter docs.
