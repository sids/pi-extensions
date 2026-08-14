# @siddr/pi-shared-qna

Shared helpers used by siddr pi extensions.

## Exports

- `@siddr/pi-shared-qna`: Q&A TUI helpers used by `pi-answer` and `pi-plan-md`.
- `@siddr/pi-shared-qna/session-editor-component`: session-scoped editor component helpers shared by UI extensions.
- `@siddr/pi-shared-qna/project-trust`: helper for consistently checking Pi project trust.
- `@siddr/pi-shared-qna/extension-mode`: helper for consistently detecting real TUI mode.
- `@siddr/pi-shared-qna/plannotator-feedback`: shared Plannotator decision handling, model delivery, and readable feedback rendering.
- `@siddr/pi-shared-qna/plannotator-url`: concurrent Plannotator port selection, URL styling, Tailscale host discovery, and managed `tailscale serve` session publishing.
- `@siddr/pi-shared-qna/system-prompt-diagnostic`: helper to summarize loaded context files and skills from `ctx.getSystemPromptOptions()`.
- `@siddr/pi-shared-qna/diff-target`: shared Git diff-target parsing, discovery, and interactive selection.
- `@siddr/pi-shared-qna/git-patch`: shared untracked-file patch synthesis, including binary and unborn-repository files.
