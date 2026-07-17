# Review extension

Interactive code-review mode for pi.

## Install

```bash
pi install npm:@siddr/pi-review
```

## What it does

- `/review` toggles review mode:
  - when inactive, it starts review mode
  - when active, it ends review mode
- Supports review targets:
  - uncommitted changes
  - base branch diff
  - specific commit
  - pull request (with `gh pr view` + `gh pr checkout`)
  - folder/file snapshot review
  - custom review instructions
- Loads project-specific `REVIEW_GUIDELINES.md` from the directory containing `.pi` (if present) and applies it as hidden review instructions while review mode is active.
- Shows a banner above the editor while active:
  - `Review mode active; /review to exit.`

## Commands

- `/review` (interactive target selection)
- `/review uncommitted`
- `/review branch <name>`
- `/review commit <sha> [title...]`
- `/review folder <paths...>`
- `/review custom [instructions...]`
- `/review pr <number-or-url>`

Direct command arguments support single and double quotes, so paths and instructions can contain spaces:

```bash
/review commit abc123 "Fix URL handling"
/review folder src "test fixtures"
/review custom 'focus on auth and error handling'
```

Pull-request reviews require the GitHub CLI (`gh`) to be installed and authenticated. If `gh --version` or `gh auth status` fails, the extension shows setup guidance before attempting to fetch PR details.

## Start and end flow

When review mode starts, the extension asks where to start (`Empty branch` or `Current branch`) only when the session has branchable history. It then resolves the target, enables review mode, and previews the selected review prompt with a 10-second countdown. The prompt is submitted automatically when the countdown ends; press `Esc` to edit it or `Ctrl+C` to stop auto-submit. In either case, the prompt moves into the editor.

For `Empty branch` reviews of uncommitted changes, the extension also generates a change summary from the source branch's session history. Press `Esc` or `Ctrl+C` while the summary is being generated to cancel it and continue review startup without a summary. When generation completes, the summary focuses on goal and motivation and is included in the startup prompt, so pressing `Esc` or `Ctrl+C` during the countdown moves both the review request and summary into the editor for adjustment.

When review mode starts and ends, summaries and triage context use target-specific labels such as `current changes`, `changes against 'main'`, `commit abc1234: title`, `PR #42: title`, or `folders: src, docs`.

When review mode ends, the extension opens triage for recorded comments (keep/discard, priority, optional note). If triage is confirmed, it exits review mode, restores model/thinking values captured at start, and posts a summary containing kept comments only. The follow-up prompt is shown with the same 10-second auto-submit countdown; press `Esc` to edit it or `Ctrl+C` to stop auto-submit. If no comments are kept, review mode exits cleanly without posting a summary or follow-up prompt.

## Review-mode tool

While review mode is active, the extension temporarily restricts active tools to review-safe tools and enables one review-only tool:

- `add_review_comment`

When review mode exits, the previously active tool list is restored.

### `add_review_comment` schema

```json
{
  "priority": "P0 | P1 | P2 | P3",
  "comment": "string",
  "references": [
    {
      "filePath": "string",
      "startLine": 1,
      "endLine": 2
    }
  ]
}
```

Validation:
- `comment` must be non-empty after trim.
- `startLine >= 1`.
- `endLine >= startLine` when provided.
- `filePath` is trimmed + normalized.

## Acknowledgements

This extension is based on the original implementation from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff).
