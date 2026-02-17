# Status extension

Shows a status widget below the input editor with session context (plus an optional PR line):

- Current provider/model
- Current thinking level
- Current working directory
- Current Git branch
- Context usage percent
- Last loop, agent, and session times (`<loop> loop · <agent> agent · <session> session`)
- Current GitHub PR URL for the active branch (includes `(merged)` / `(closed)` when not open)

Time values use a compact `d/h/m` format (`XdYhZm`, `YhZm`, or `Zm`) and are separated with a center dot (`·`).

Also updates the terminal title to append an emoji indicating whether the harness is running (♨️) or done (✅). When you start typing, the done emoji is removed and stays hidden until the next run. The default footer widget is hidden while this extension is active.

## Usage

Load the extension (e.g. symlink the folder into `~/.pi/agent/extensions/status` and run `/reload`). The status line updates automatically during session events.

PR detection requires GitHub CLI (`gh`) and valid auth (`gh auth status`). By default, the PR line is resolved only for `github.com`. You can allow additional GitHub Enterprise hosts with `PI_STATUS_ALLOWED_GITHUB_HOSTS` (comma-separated exact hostnames).

Toggle the behavior with `/custom-status`.

## Tests

```bash
bun test status/tests/utils.test.ts
```
