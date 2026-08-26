# herdr-integration extension

Reports Pi's session identity and `idle`, `working`, or `blocked` lifecycle state directly to Herdr.

The extension activates only for Pi's root TUI session when all of these Herdr environment variables are available:

- `HERDR_ENV=1`
- `HERDR_SOCKET_PATH`
- `HERDR_PANE_ID`

It replaces Herdr's managed Pi integration. Remove that integration before loading this extension so there is only one lifecycle authority:

```bash
herdr integration uninstall pi
```

## Behavior

For ordinary assistant questions, the extension appends this guidance to Pi's system prompt on every agent run:

```text
<herdr_integration>
When you cannot continue until you receive a response, end your final response with :input_needed: on a line by itself.
Use the marker only when a response is required to continue. Do not use it for optional questions, suggestions, or completed work.
</herdr_integration>
```

When the final line of the latest assistant response is `:input_needed:`, the extension reports `blocked` directly to Herdr. It reports `working` when the next agent run starts and `idle` when the agent settles without requiring input. A display-only Markdown transformer hides complete markers and their trailing streaming prefixes in Pi's TUI while preserving the final marker in the session. The extension restores session identity and unanswered blocked state after `/reload`, `/resume`, or process restart, but not when a later user message already supplied input.

The extension also consumes the shared `pi:waiting-for-user-input` event used by interactive extensions such as `plan-md` and `task-subagents`. Multiple simultaneous waits are aggregated, so Herdr remains blocked until all active reasons have cleared.

Socket reports use Herdr's `herdr:pi` source, monotonically increasing sequence numbers, serialized state delivery, and one retry. Pending state changes are coalesced while a report is in flight.

## Install

```bash
pi install npm:@siddr/pi-herdr-integration
```

Or symlink it locally into `~/.pi/agent/extensions/herdr-integration` and run `/reload`.

## Notes

- The sentinel must be the final non-empty line; merely discussing `:input_needed:` does not mark the session blocked.
- The sentinel remains part of the stored assistant message and model context, but is hidden from Pi's Markdown rendering.
- The extension computes one absolute state, so blocked reporting does not depend on balanced increment/decrement events.
- Outside a complete Herdr environment, the extension registers no hooks.
- In non-TUI Pi modes, including RPC, print, and JSON mode, the extension does not modify the system prompt or report lifecycle state.

## Tests

```bash
pnpm test -- herdr-integration/tests/*.test.ts
```
