# pi-diff-cmux

GitHub-style diff review in cmux browser panes and surfaces for pi.

## Commands

- `/diff-cmux-pane [target]` — opens the viewer in a new browser pane on the right, defaulting to unified mode.
- `/diff-cmux-surface [target]` — opens the viewer as a browser surface in the current pane, defaulting to split mode.

## Supported targets

- `uncommitted`
- `branch <name>`
- `commit <sha>`

Examples:

- `/diff-cmux-pane uncommitted`
- `/diff-cmux-pane branch main`
- `/diff-cmux-surface commit abc123`

If you omit args, the extension offers an interactive target picker.

## Viewer behavior

- Continuous changed-files stream, similar to GitHub's changed-files review view.
- Collapsible grouped-path sidebar with fuzzy search, status markers, comment badges, and reviewed indicators.
- Unified/split toggle and wrap toggle.
- Line, file, and overall comments.
- Manual reviewed/unreviewed tracking persisted in browser storage for that viewer token.
- Send individual comments from each draft textarea, use Cmd+Enter on macOS or Ctrl+Enter elsewhere, or send all unsent comments at once.
- Sent output is formatted as a compact “Please address the following feedback” prompt, and appends on a new line when the editor already has content.

## cmux requirements

This extension expects:

- `cmux` to be installed
- a current cmux workspace
- `/diff-cmux-surface` to resolve the active pane via `cmux identify`

## Local development

Install deps in `diff-cmux/` if needed, then build the browser bundle:

```bash
cd diff-cmux
npm install
npm run build
bun test tests/*.test.ts
```

To load locally, symlink `diff-cmux/` into `~/.pi/agent/extensions/diff-cmux` and run `/reload` in pi.
