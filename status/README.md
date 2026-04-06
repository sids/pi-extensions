# Status extension

Shows a status widget below the input editor with session context (plus an optional PR line):

- Current provider/model
- Current thinking level
- Current OpenAI fast/verbosity indicators from `openai-params` when non-default, shown inside the thinking parentheses (`/fast`, `🗣️low`, `🗣️medium`, `🗣️high`)
- Current working directory
- Current Git branch
- Context usage percent plus used token count
- Current/last agent time plus cumulative turn total and session time (`<agent> agent · <turn total> turn total · <session> session`)
- Current GitHub PR URL for the active branch (includes `(merged)` / `(closed)` when not open)

Time values use a compact `d/h/m` format (`XdYhZm`, `YhZm`, or `Zm`) and are separated with a center dot (`·`). Agent time reflects the current or last completed prompt run. Turn total accumulates time spent across turns in the current session. All timers reset when a new session starts. The default footer widget is hidden while this extension is active.

## Install

```bash
pi install npm:@siddr/pi-status
```

## Usage

The status widget updates automatically during session events.

If `openai-params` is installed, the widget also listens for its event-bus updates and shows the current non-default fast/verbosity settings inside the thinking-level parentheses for the active workspace.

PR detection requires GitHub CLI (`gh`) and valid auth (`gh auth status`). By default, the PR line is resolved only for `github.com`. You can allow additional GitHub Enterprise hosts with `PI_STATUS_ALLOWED_GITHUB_HOSTS` (comma-separated exact hostnames).

Toggle the behavior with `/custom-status`.

## Tests

```bash
bun test status/tests/*.test.ts
```
