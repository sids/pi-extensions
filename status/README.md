# Status extension

Shows a status widget below the input editor with session context (plus an optional PR line):

- Current provider/model
- Current thinking level
- Current working directory
- Current Git branch
- Context usage percent
- Last loop time plus cumulative agent and session times (`<loop> loop · <agent> agent · <session> session`)
- Current GitHub PR URL for the active branch (includes `(merged)` / `(closed)` when not open)

Time values use a compact `d/h/m` format (`XdYhZm`, `YhZm`, or `Zm`) and are separated with a center dot (`·`). Session and agent timers are monotonic and carry forward across session/branch switches.

Also updates the terminal title with a prefix indicating state:

- Braille spinner frame while the agent is running
- `✔` when the agent is done (after at least one completed run, cleared on next editor activity)
- `⚠️` when attention is needed

Attention mode is triggered when a run ends with `stopReason: "error"` or `stopReason: "aborted"`, when a non-`bash` tool whose name does not include `agent` runs longer than 10 seconds, or when an extension emits `status:title_attention`. The default footer widget is hidden while this extension is active.

## Usage

Load the extension (for example, symlink the folder into `~/.pi/agent/extensions/status` and run `/reload`). The status line updates automatically during session events.

PR detection requires GitHub CLI (`gh`) and valid auth (`gh auth status`). By default, the PR line is resolved only for `github.com`. You can allow additional GitHub Enterprise hosts with `PI_STATUS_ALLOWED_GITHUB_HOSTS` (comma-separated exact hostnames).

Toggle the behavior with `/custom-status`.

## Tests

```bash
bun test status/tests/utils.test.ts
```

## Acknowledgements

The terminal title behavior is inspired by the approach used in the pi-mono repo.
