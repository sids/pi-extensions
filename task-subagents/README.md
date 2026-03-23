# Task Subagents extension

Standalone delegated research tools for pi.

## Install

```bash
pi install npm:pi-task-subagents
```

## What it does

Adds two general-purpose tools:

- `subagents` — run one or more isolated read-only research tasks in parallel
- `steer_subagent` — rerun one task from a previous `subagents` run with extra guidance

Each subagent gets its own temporary pi agent directory copy so concurrent runs can reuse auth and settings without fighting over lock files.

In interactive UI mode, `subagents` opens a pre-launch review screen before any child process starts. You can review each prompt and cwd, cycle per-task model and thinking overrides, cancel individual tasks with a note, and confirm the final launch plan. By default, launched subagents inherit the main agent's current model and thinking level. In headless mode, tasks still launch immediately.

Run results now report launched, succeeded, failed, and cancelled counts, and `steer_subagent` reuses any reviewed model/thinking overrides when it reruns a task.

## Notes

- This extension is optional and works on its own.
- It complements `pi-plan-md`, but `pi-plan-md` does not require it.
- If both extensions are installed, `subagents` and `steer_subagent` are also available during plan mode.
- `subagents` keeps recent run IDs in memory so `steer_subagent` can target prior tasks from the same session.
