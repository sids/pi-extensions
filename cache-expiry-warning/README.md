# Cache Expiry Warning extension

Shows a warning above Pi's editor when a configured prompt cache may expire before another turn starts.

## Install

```bash
pi install npm:@siddr/pi-cache-expiry-warning
```

## Behavior

- During each turn, the extension inspects the outgoing provider payload for prompt-cache configuration and records when the request is sent.
- At the end of the turn, it schedules only the time remaining in the cache window. If the cache window elapsed while Pi was responding or running tools, the warning appears immediately.
- Starting another turn cancels the timer and clears any warning.
- The default short-cache window is 5 minutes, matching Pi's cache expiry threshold.
- Long retention is read from the provider payload as seen by the extension:
  - Anthropic-style and Bedrock cache controls: normally 1 hour
  - OpenAI `prompt_cache_retention`: normally 24 hours
- When `openai-params` actually patches a request for 24-hour retention, it reports the effective TTL so the warning remains correct regardless of extension load order.
- When the timer expires, the extension displays a warning above the editor. It does not add anything to model context.
- Timers and widgets are cleared when the model or session changes and when Pi shuts down.

## Accuracy

The extension uses recognized cache controls, cache keys, and retention fields to determine the cache window. It does not guess an expiry time from token usage alone.

Long-retention timing comes from the cache TTL Pi serializes into the outgoing provider payload, rather than from the `PI_CACHE_RETENTION` environment variable alone. If a custom provider enables caching without serializing a recognized TTL, the extension does not show an expiry warning.
