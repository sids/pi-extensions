# Task Subagents extension

Standalone delegated research tools for pi.

## Install

```bash
pi install npm:pi-task-subagents
```

## What it does

Adds two general-purpose tools:

- `subagents` — launch one or more isolated read-only research tasks from a single tool call, preferably as one batched `tasks` array
- `steer_subagent` — rerun one task from a previous `subagents` run with extra guidance

Each subagent gets its own temporary pi agent directory copy so concurrent runs can reuse auth and settings without fighting over lock files.

`subagents` also accepts two optional launch-level parameters:

- `thinking_level` — `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`; defaults to the current thinking level
- `context` — `fresh` or `fork`; defaults to `fresh`. `fork` launches each subagent from the current saved session.

In interactive UI mode, `subagents` opens a pre-launch review screen before any child process starts. You can review each prompt and cwd, cycle per-task model and thinking overrides, cycle per-task launch context with `Ctrl+F`, cancel individual tasks with a note, and confirm the final launch plan. By default, launched subagents inherit the main agent's current model and thinking level unless `thinking_level` is provided. Concurrent `subagents` tool calls share one merged launch review so you do not get overlapping TUI prompts. In headless mode, tasks still launch immediately.

Run results now report launched, succeeded, failed, and cancelled counts, and `steer_subagent` reuses any reviewed model/thinking overrides and fork context when it reruns a task.

## Notes

- This extension is optional and works on its own.
- It complements `pi-plan-md`, but `pi-plan-md` does not require it.
- If both extensions are installed, `subagents` and `steer_subagent` are also available during plan mode.
- `subagents` keeps recent run IDs in memory so `steer_subagent` can target prior tasks from the same session.
