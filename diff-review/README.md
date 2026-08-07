# pi-diff-review

Browser diff review for pi, powered by [Plannotator](https://github.com/backnotprop/plannotator).

## Install

```bash
pi install npm:@siddr/pi-diff-review
```

Plannotator is included as a runtime dependency; it does not need to be installed as a separate pi extension.

## Commands

- `/diff-review [target]` — opens a Plannotator code review in the configured browser.

## Supported targets

- `uncommitted`
- `branch <name>`
- `commit <sha>`

Examples:

- `/diff-review uncommitted`
- `/diff-review branch main`
- `/diff-review commit abc123`

If you omit args and the working tree has uncommitted changes, the extension reviews those changes immediately. If the working tree is clean, it offers an interactive target picker.

## Review behavior

Plannotator provides the diff viewer, file navigation, annotations, approval flow, and browser server. Requested-change feedback is sent directly to the agent. Approval closes the review without sending a message.

Browser launching follows Plannotator configuration, including the `PLANNOTATOR_BROWSER`, `PLANNOTATOR_REMOTE`, and `PLANNOTATOR_PORT` environment variables. Printed review URLs use the accent color and underline styling. With `PLANNOTATOR_REMOTE=1`, the extension also reads `tailscale status --json` and prints a Tailscale URL when a host is available.

## Local development

Install dependencies at the repository root, then run the extension tests:

```bash
pnpm install
pnpm --filter @siddr/pi-diff-review test
```

To load locally, symlink `diff-review/` into `~/.pi/agent/extensions/diff-review` and run `/reload` in pi.
