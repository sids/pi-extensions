# cmux-status extension

Sets cmux sidebar status entries for pi when running inside cmux (`CMUX_WORKSPACE_ID` is set).

Keys:

- named session: `pi-cmux-status:<name>`
- unnamed session: `pi-cmux-status`

The status text is:

- `π <name>: <status>` for named sessions
- `π - <status>` for unnamed sessions

Status values:

- `Ready`
- `Working`
- `Waiting`
- `Error`

Behavior:

- `Ready` when idle
- `Working` while the agent is running
- `Waiting` while another extension emits `pi:waiting-for-user-input` with `{ waiting: true }`
- `Error` after a tool finishes with an error, until the next session or new agent run
- named sessions clear their cmux status again once the agent finishes and the session returns to idle

Conflict handling across multiple pi instances in the same cmux workspace:

- if the current sidebar value still matches what this instance last wrote, it overwrites freely
- otherwise it only overwrites when the new status has higher priority than the current one
- priority: `Error > Waiting > Working > Ready`
- on disable/shutdown it only clears the status if the current value still matches what this instance last wrote

This extension does not render any TUI widget or footer content, and it does not use the cmux progress bar.

## Install

```bash
pi install npm:@siddr/pi-cmux-status
```

Or symlink it locally into `~/.pi/agent/extensions/cmux-status` and run `/reload`.

## Usage

The extension manages the session-specific cmux sidebar status entry via:

- `cmux list-status`
- `cmux set-status`
- `cmux clear-status`

For `Waiting`, cooperating extensions can emit the shared inter-extension event:

```ts
pi.events.emit("pi:waiting-for-user-input", {
  source: "my-extension",
  id: "some-stable-id",
  waiting: true,
});

pi.events.emit("pi:waiting-for-user-input", {
  source: "my-extension",
  id: "some-stable-id",
  waiting: false,
});
```

Toggle the behavior with `/custom-cmux-status`.

## Tests

```bash
bun test cmux-status/tests/utils.test.ts
bun test cmux-status/tests/index.test.ts
```
