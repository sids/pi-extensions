# Plan Mode extension

Branch-based planning workflow for pi.

## What it does

- `/plan-mode` starts planning when inactive (and opens plan-mode actions when already active), with a mode picker similar to `/review`:
  - `Empty branch` (jumps to a clean branch point)
  - `Current branch` (stays where you are)
  and enters planning workflow mode.
- `/plan-mode` accepts an optional location argument:
  - if the argument is a file path, that exact file is used as the plan file
  - if the argument is a directory, plan mode creates `<timestamp>-<sessionId>.plan.md` inside it
- When plan mode is inactive and a session plan file already exists with plan content, startup uses one combined chooser:
  - `Continue planning`
  - `Empty branch`
  - `Current branch`
  and shows the existing plan file path on a separate line in the prompt.
  Choosing `Continue planning` resumes from the last saved planning branch leaf when available.
  Choosing `Empty branch` or `Current branch` starts fresh planning with a new timestamped plan file (unless `/plan-mode [location]` is provided).
- Shows a persistent banner above the editor:
  - `Plan mode active; \`/plan-mode\` to exit. \`/plan-mode <location>\` to move plan file.`
  - `Plan file: <path>`
- Exposes a `subagents` tool for isolated research tasks with per-task activity traces, run IDs, and task IDs (concurrency is an integer from 1 to 4).
- Exposes a `steer_subagent` tool to rerun one task from a previous `subagents` run with additional steering.
- Exposes a `request_user_input` tool for Codex-style clarifying questions with optional choices (supports both multiple-choice and open-ended prompts), inline custom response, and optional skip via empty answer. Question IDs must be non-empty and unique.
- Exposes a `set_plan` tool that overwrites the active plan file with the complete latest plan text; result view is compact by default and expandable with `Ctrl+O` to inspect the full written plan.
- Running `/plan-mode` while already active (without args) shows:
  - `Exit`
  - `Exit & summarize branch`
  and `Esc` keeps you in plan mode.
- Running `/plan-mode <location>` while already active moves the current plan file to the resolved location and updates the active plan file path.
- Moving a plan file prompts for confirmation before overwriting an existing target file (and refuses overwrite in non-interactive mode).
- Starting fresh with `/plan-mode <location>` also prompts before overwriting an existing target file.
- Exiting plan mode prefills the editor only when the active plan file has non-empty content; the prefill includes `Plan file: <path>` on the first line and a short implementation instruction on the next line.
- After exiting plan mode, a `Plan mode ended.` message is shown; when a plan exists it displays `Plan file: <path>` and can be expanded with `Ctrl+O` to inspect the saved plan text, otherwise it shows `No plan created.`.

## Commands

- `/plan-mode [location]` (starts planning when inactive; opens active plan-mode actions when already active; with a location while active, moves the plan file)

## Tools in plan mode

Plan mode adds planning-specific tools only while plan mode is active, without changing your other enabled tools. When plan mode ends, these tools are removed again.

Plan-mode specific tools:
- `subagents`
- `steer_subagent`
- `request_user_input`
- `set_plan`

## Notes

- `subagents` runs each task in its own `pi --mode json --no-session` subprocess with isolated context.
- `subagents` emits per-task progress updates while running and stores run/task identifiers in the result.
- `steer_subagent` reruns one task from a prior run with extra guidance, preserving context isolation.
- The extension persists plan-mode state in session custom entries so it can recover after reloads/session switches.
- Plan mode creates an internal plan file at start; `set_plan` keeps that file up to date and the active `/plan-mode` end flow operates on it.
- Plan mode does not extract plan content from assistant messages; the plan file is the canonical source of truth.
- By default, plan mode uses one plan file per session in the same directory as the session file, replacing the session file extension with `.plan.md`; `/plan-mode [location]` can override this path.
- Plan files are retained after exiting plan mode so you can resume later; starting plan mode again lets you resume or start fresh.
- Return-to-origin uses the stored origin entry ID in the current session tree (review-style flow), not cross-session reconstruction.
