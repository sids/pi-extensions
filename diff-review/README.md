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

Plannotator provides the diff viewer, file navigation, annotations, approval flow, and browser server. The browser review runs asynchronously, so pi remains responsive while it is open. Requested-change feedback can be submitted at any time and is sent directly to the agent as steering. Approval closes the review without sending a message.

Browser launching follows Plannotator configuration, including the `PLANNOTATOR_BROWSER`, `PLANNOTATOR_REMOTE`, and `PLANNOTATOR_PORT` environment variables. Unless `PLANNOTATOR_PORT` is set, each review uses an OS-assigned free port so multiple browser sessions can remain open concurrently. An explicit fixed port or port range is honored. Printed review URLs use the accent color and underline styling.

Set `PLANNOTATOR_TAILSCALE=1` to keep the review server bound to loopback and publish it through `tailscale serve` with a tailnet-only HTTPS URL and terminal QR code. The mapping is removed when the review ends, and this mode takes precedence over `PLANNOTATOR_REMOTE`. Without it, `PLANNOTATOR_REMOTE=1` retains the direct-bind behavior and prints a reachable Tailscale URL when one can be detected.

## Local development

Install dependencies at the repository root, then run the extension tests:

```bash
pnpm install
pnpm --filter @siddr/pi-diff-review test
```

To load locally, symlink `diff-review/` into `~/.pi/agent/extensions/diff-review` and run `/reload` in pi.
