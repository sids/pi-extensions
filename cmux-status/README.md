# cmux-status extension

Sets cmux sidebar status entries for pi when running inside cmux (`CMUX_WORKSPACE_ID` is set).

Keys:

- all sessions: `pi-cmux-status:<owner>`

`<owner>` is derived from the current cmux surface and panel ids, so each pi instance manages its own deterministic sidebar entry. If cmux does not expose an owner id for the current process, the extension does nothing.

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
- `Working` while the agent is running, with an animated textual spinner prefix
- `Waiting` while another extension emits `pi:waiting-for-user-input` with `{ waiting: true }`, with a dedicated icon and a one-shot `cmux notify`
- `Error` after a tool finishes with an error, until the next session or new agent run, with a dedicated icon
- named and unnamed sessions both show `Ready` again once the session returns to idle

Multiple pi instances in the same cmux workspace do not share a sidebar key anymore: each instance writes to its own surface/panel-specific key and clears only that key on disable/shutdown.

This extension does not render any TUI widget or footer content, and it does not use the cmux progress bar.

## Install

```bash
pi install npm:@siddr/pi-cmux-status
```

Or symlink it locally into `~/.pi/agent/extensions/cmux-status` and run `/reload`.

## Usage

The extension manages the session-specific cmux sidebar status entry via:

- `cmux set-status`
- `cmux clear-status`
- `cmux notify`

Notes:

- `Ready` uses a `checkmark` icon.
- `Waiting` uses an `hourglass` icon.
- `Error` uses an `exclamationmark.triangle.fill` icon.
- `Working` does not use a cmux icon; it animates with the same braille-style textual spinner frames pi uses, such as `⠋`.

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
