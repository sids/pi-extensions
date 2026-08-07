# herdr-integration extension

Reports Pi as blocked in Herdr when Pi cannot continue without user input.

The extension activates only for Pi's root UI session when all of these Herdr environment variables are available:

- `HERDR_ENV=1`
- `HERDR_SOCKET_PATH`
- `HERDR_PANE_ID`

It works with Herdr's managed Pi integration, which listens for the `herdr:blocked` inter-extension event and reports the resulting state to Herdr.

## Behavior

For ordinary assistant questions, the extension appends this guidance to Pi's system prompt on every agent run:

```text
<herdr_integration>
When you cannot continue until you receive a response, end your final response with :input_needed: on a line by itself.
Use the marker only when a response is required to continue. Do not use it for optional questions, suggestions, or completed work.
</herdr_integration>
```

When the final line of the latest assistant response is `:input_needed:`, the extension emits:

```ts
pi.events.emit("herdr:blocked", {
	active: true,
	label: "input needed",
});
```

It clears that state when the next agent run starts. A display-only Markdown transformer hides complete markers and their trailing streaming prefixes in Pi's TUI while preserving the final marker in the session. The extension restores an unanswered blocked state after `/reload`, `/resume`, or process restart, but not when a later user message already supplied input.

The extension also consumes the shared `pi:waiting-for-user-input` event used by interactive extensions such as `plan-md` and `task-subagents`. Multiple simultaneous waits are aggregated, so Herdr remains blocked until all active reasons have cleared.

The extension does not contact the Herdr socket itself. Herdr's managed Pi integration owns transport and agent-state reporting.

## Install

```bash
pi install npm:@siddr/pi-herdr-integration
```

Or symlink it locally into `~/.pi/agent/extensions/herdr-integration` and run `/reload`.

## Notes

- The sentinel must be the final non-empty line; merely discussing `:input_needed:` does not mark the session blocked.
- The sentinel remains part of the stored assistant message and model context, but is hidden from Pi's Markdown rendering.
- Blocked events are emitted only on state transitions to keep Herdr's blocked-event accounting balanced.
- Outside a complete Herdr environment, the extension registers no hooks.
- In non-UI Pi modes, including print and JSON mode, the extension does not modify the system prompt or report blocked state.

## Tests

```bash
pnpm test -- herdr-integration/tests/*.test.ts
```
