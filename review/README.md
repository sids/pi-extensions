# Review extension

Interactive code-review mode for pi.

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

## Start and end flow

When review mode starts, the extension asks where to start (`Empty branch` or `Current branch`), resolves the target, enables review mode, and prefills the editor with the selected review focus before you send the first review prompt.

When review mode ends, the extension opens triage for recorded comments (keep/discard, priority, optional note). If triage is confirmed, it exits review mode, restores model/thinking values captured at start, and posts a summary containing kept comments only. If no comments are kept, it exits cleanly without posting a summary.

## Review-mode tool

While review mode is active, the extension enables one tool:

- `add_review_comment`

When review mode exits, the tool is removed from active tools.

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
