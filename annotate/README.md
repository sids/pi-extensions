# @siddr/pi-annotate

Open the last assistant message in Plannotator and send annotation feedback directly to the agent.

## Install

```bash
pi install npm:@siddr/pi-annotate
```

Plannotator is included as a runtime dependency and does not need to be installed separately.

## Usage

```text
/annotate
/annotate path/to/file.md
/annotate path/to/folder
```

With no path, the command finds the latest non-empty assistant message on the current session branch and opens it in Plannotator's last-message annotation UI. A file path opens that file directly, including supported Markdown-like, plain-text, configuration, and HTML files. A directory opens Plannotator's folder browser. Paths are resolved relative to Pi's working directory and may be quoted when they contain spaces.

The command waits for any active agent response to finish before opening. Pi remains available while the browser session is open.

- Submitted feedback is sent directly to the agent while preserving its original Markdown.
- If the agent is already busy, feedback is queued as a follow-up.
- Approval and closing the annotation without feedback do not send anything.
- Feedback is not delivered if the session or conversation branch moves while the browser is open.
- Open browser sessions are stopped when the Pi session shuts down or reloads.
- The command is available only in TUI mode.

Browser launching follows Plannotator configuration, including `PLANNOTATOR_BROWSER`, `PLANNOTATOR_REMOTE`, and `PLANNOTATOR_PORT`. Printed URLs use Pi's accent color and underline styling.

Set `PLANNOTATOR_TAILSCALE=1` to publish every Plannotator session over `tailscale serve`. The browser server remains bound to loopback, while Tailscale provides a tailnet-only HTTPS URL and a terminal QR code. The mapping is removed when the review ends. This mode takes precedence over `PLANNOTATOR_REMOTE`.

Without first-class Tailscale mode, `PLANNOTATOR_REMOTE=1` retains the direct-bind behavior and prints a reachable Tailscale URL when `tailscale status --json` reports a host.
