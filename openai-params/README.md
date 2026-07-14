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

- Fast mode is applied to any model whose ID starts with `gpt-` on the official `openai` and `openai-codex` providers when they use a compatible API:
  - `openai-completions`
  - `openai-responses`
  - `openai-codex-responses`
- Models from GitHub Copilot, local servers, and custom proxies are not patched merely because they use an OpenAI-compatible serializer.
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
  "verbosity": null
}
```

Older `supportedModels` settings are ignored because fast-mode support is detected from the active model provider, ID, and API.

## Integration

This extension emits its current state on pi's extension event bus over `pi:openai-params` with:

- `source`
- `cwd`
- `fast`
- `verbosity`

That lets other extensions, including `status`, show the active non-default fast/verbosity settings for the current workspace.

## Notes

This extension combines the behavior of:

- `@benvargas/pi-openai-fast` for `service_tier=priority`
- `pi-verbosity-control` for `text.verbosity`

based on OpenAI GPT-5 / Responses API parameter docs.
