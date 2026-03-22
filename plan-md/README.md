# Plan Mode extension

Branch-based planning workflow for pi.

## Install

```bash
pi install npm:pi-plan-md
```

## What it does

- `/plan-md` starts planning when inactive and opens plan mode actions when already active.
- `Alt+P` runs the same plan-mode toggle flow as `/plan-md` (including the same start/end prompts and exit behavior) without sending `/plan-md` as chat text.
- Start location picker (shown when the session has branchable history):
  - `Empty branch` (jumps to a clean branch point)
  - `Current branch` (stays where you are)
- If a session plan already exists with content, startup offers:
  - `Continue planning`
  - `Empty branch` / `Current branch` when branchable history is available
  - `Start fresh` when no branchable history is available
- `/plan-md` accepts an optional location argument:
  - file path → use that exact file as the plan file
  - directory path → create `<timestamp>-<sessionId>.plan.md` in that directory
- Shows a persistent banner while active:
  - `Plan mode active; /plan-md to exit. /plan-md <location> to move plan file.`
  - `Plan file: <path>`
- Running `/plan-md` while active (without args) shows:
  - `Exit`
  - `Exit & stay in current branch`
- Running `/plan-md <location>` while active moves the current plan file to the resolved location.
- Starting or moving to an existing file asks for overwrite confirmation (and refuses overwrite in non-interactive mode).
- `Exit` returns to the point from before plan mode started. If that point was the root user message, it restores a fresh branch from that message instead of dropping to an empty root.
- `Exit & stay in current branch` ends plan mode without navigating away from the planning branch tip.
- Exiting plan mode prefills the editor only when the active plan file has content.
- After exit, a `Plan mode ended.` message is shown. When a plan exists, the message includes `Plan file: <path>` and an expandable plan preview (`Ctrl+O`); otherwise it shows `No plan created.`.

## Commands

- `/plan-md [location]`

## Built-in tools in plan mode

Plan mode adds these tools only while active:

- `request_user_input` — ask clarifying questions with optional choices and optional freeform answers
- `set_plan` — overwrite the active plan file with the complete latest plan text

When plan mode ends, these tools are removed again.

## Optional companion extension

If you also want delegated research tools, install `pi-task-subagents` separately:

```bash
pi install npm:pi-task-subagents
```

That adds `subagents` and `steer_subagent` everywhere, including during plan mode, but `pi-plan-md` does not require it.

## Notes

- By default, plan mode uses one plan file per session in the same directory as the session file, replacing the session extension with `.plan.md`.
- `/plan-md [location]` can override the plan file path.
- Plan files are kept after exiting so planning can be resumed later.
- The default plan-mode prompt is stored in `plan-md/prompts/PLAN.prompt.md`.
- You can override that prompt globally by creating `~/.pi/agent/PLAN.prompt.md`.
- If the override file is missing or blank, the bundled prompt is used.
