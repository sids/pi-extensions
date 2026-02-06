# Status extension

Shows a single-line status widget below the input editor with session context:

- Current provider/model
- Current thinking level
- Current working directory
- Current Git branch
- Context usage percent
- Latest agent loop runtime (e.g. `3min`)

Also updates the terminal title to append an emoji indicating whether the harness is running (♨️) or done (✅). When you start typing, the done emoji is removed and stays hidden until the next run. The default footer widget is hidden while this extension is active.

## Usage

Load the extension (e.g. symlink the folder into `~/.pi/agent/extensions/status` and run `/reload`). The status line updates automatically during session events.

Toggle the behavior with `/custom-status`.

## Tests

```bash
bun test status/tests/utils.test.ts
```
