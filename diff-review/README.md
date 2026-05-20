# pi-diff-review

Browser diff review for pi.

## Commands

- `/diff-review [target]` — starts a local HTTP diff review and opens it in a browser.

## Supported targets

- `uncommitted`
- `branch <name>`
- `commit <sha>`

Examples:

- `/diff-review uncommitted`
- `/diff-review branch main`
- `/diff-review commit abc123`

If you omit args and the working tree has uncommitted changes, the extension reviews those changes immediately. If the working tree is clean, it offers an interactive target picker.

When run inside cmux, the extension asks where to open the review:

1. cmux Surface
2. cmux Pane (right)
3. Default Browser

If [`glimpseui`](https://github.com/hazat/glimpse) is installed, `Glimpse` is also offered as an open target.

## Review behavior

- Continuous changed-files stream, similar to GitHub's changed-files review view.
- File tree sidebar powered by `@pierre/trees`.
- Diffs powered by `@pierre/diffs`.
- Unified/split toggle and wrap toggle.
- Line, file, and overall comments.
- Manual reviewed/unreviewed tracking persisted in browser storage for that review token.
- Send individual comments from each draft textarea, use Cmd+Enter on macOS or Ctrl+Enter elsewhere, or send all unsent comments at once.
- Sent output is formatted as review feedback and appends to the pi editor.

## Local development

Install deps at the repository root, then build the browser bundle when you want to verify frontend bundling. Built assets under `web/dist/` are generated and not committed:

```bash
pnpm install
pnpm --filter @siddr/pi-diff-review build
pnpm --filter @siddr/pi-diff-review test
```

To load locally, symlink `diff-review/` into `~/.pi/agent/extensions/diff-review` and run `/reload` in pi.
