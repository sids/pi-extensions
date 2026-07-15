# @siddr/pi-side

Ephemeral floating side conversations for [pi](https://github.com/earendil-works/pi-mono).

## Installation

```bash
pi install npm:@siddr/pi-side
```

For local development, symlink this directory to `~/.pi/agent/extensions/side` and run `/reload`.

## Usage

```text
/side
/side What does the latest error mean?
```

`/side` creates an in-memory child `AgentSession`, immediately opens a centered floating overlay, and summarizes a frozen snapshot of the current main branch in the background. You can type while summarization runs; sending is enabled when it finishes. The main agent continues independently behind the overlay. Only one side chat can be open at a time.

The initial summary is compact rather than a raw conversation copy and appears as a scrollable `Parent summary ready` message in the side-chat transcript. The side agent can inspect finalized live main-session activity—including messages created after it opened—through dedicated status, update, search, and read tools. Summary failures are non-fatal; the live inspection tools remain available.

## Controls

The overlay honors pi's configured keybindings for:

- input submission and newline insertion
- model selection and forward/backward model cycling
- thinking-level cycling
- interrupting an active side turn

`PageUp`/`PageDown` scroll the transcript. Global `Ctrl+Shift+S` opens the side chat and toggles its panel without stopping the child. The centered panel tracks 50% of the main terminal height; `Ctrl+Shift+S` also hides the focused panel. `Ctrl+C` or `Ctrl+D` closes and discards the side chat. Side messages and tool activity use pi's standard main-TUI renderers. The active side model and thinking level remain available in the header, but their standard pi shortcuts are intentionally omitted from the panel's shortcut footer. Model and thinking changes affect only the in-memory child.

## Read-only behavior

The child receives only these project tools:

- `read`
- `grep`
- `find`
- `ls`

It does not receive `bash`, `edit`, `write`, child extensions, or subagent tools. Both sessions share the same working directory, so reads may observe files changing while the main agent works.

The side agent also has `main_session_send_message`. It may use this only after an explicit request to affect the main chat, and sends the exact message directly as a `steer` or `followUp`.

## Lifecycle

The child uses an in-memory session and is never added to `/resume`. Closing the overlay aborts active side work and disposes the child. Parent `/new`, `/resume`, `/fork`, `/reload`, shutdown, or extension teardown also closes it. Parent `/tree` navigation leaves it open; inspection tools report branch divergence.

## Limitations

- The summary and inspection tools only see finalized parent messages, not partial streaming text.
- Summaries are intentionally lossy; use the main-session tools when exact context matters.
- The overlay API is experimental in pi.
- Side prompts cannot currently be queued while the child is already running; interrupt or wait for it to settle.
