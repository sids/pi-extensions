# Plan Mode extension

Branch-based planning workflow for pi.

## What it does

- `/plan-mode` starts planning when inactive and opens plan-mode actions when already active.
- Start location picker:
  - `Empty branch` (jumps to a clean branch point)
  - `Current branch` (stays where you are)
- If a session plan already exists with content, startup offers:
  - `Continue planning`
  - `Empty branch`
  - `Current branch`
- `/plan-mode` accepts an optional location argument:
  - file path → use that exact file as the plan file
  - directory path → create `<timestamp>-<sessionId>.plan.md` in that directory
- Shows a persistent banner while active:
  - `Plan mode active; /plan-mode to exit. /plan-mode <location> to move plan file.`
  - `Plan file: <path>`
- Running `/plan-mode` while active (without args) shows:
  - `Exit`
  - `Exit & summarize branch`
- Running `/plan-mode <location>` while active moves the current plan file to the resolved location.
- Starting or moving to an existing file asks for overwrite confirmation (and refuses overwrite in non-interactive mode).
- Exiting plan mode prefills the editor only when the active plan file has content.
- After exit, a `Plan mode ended.` message is shown. When a plan exists, the message includes `Plan file: <path>` and an expandable plan preview (`Ctrl+O`); otherwise it shows `No plan created.`.

## Commands

- `/plan-mode [location]`

## Tools in plan mode

Plan mode adds planning-specific tools only while active:

- `subagents` — run isolated research tasks (concurrency: 1-4)
- `steer_subagent` — rerun one task from a previous `subagents` run with extra guidance
- `request_user_input` — ask clarifying questions with optional choices and optional freeform answers
- `set_plan` — overwrite the active plan file with the complete latest plan text

When plan mode ends, these tools are removed again.

## Notes

- By default, plan mode uses one plan file per session in the same directory as the session file, replacing the session extension with `.plan.md`.
- `/plan-mode [location]` can override the plan file path.
- Plan files are kept after exiting so planning can be resumed later.
