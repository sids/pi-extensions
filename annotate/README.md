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
```

The command waits for any active agent response to finish, finds the latest non-empty assistant message on the current session branch, and opens it in Plannotator's last-message annotation UI. Pi remains available while the browser session is open.

- Submitted feedback is sent directly to the agent while preserving its original Markdown.
- If the agent is already busy, feedback is queued as a follow-up.
- Approval and closing the annotation without feedback do not send anything.
- Feedback is not delivered if the session or conversation branch moves while the browser is open.
- Open browser sessions are stopped when the Pi session shuts down or reloads.
- The command is available only in TUI mode.

Browser launching follows Plannotator configuration, including `PLANNOTATOR_BROWSER`, `PLANNOTATOR_REMOTE`, and `PLANNOTATOR_PORT`. Printed URLs use Pi's accent color and underline styling. With `PLANNOTATOR_REMOTE=1`, the extension also reads `tailscale status --json` and prints a Tailscale URL when a host is available.
