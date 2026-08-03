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

When review mode starts, the extension asks where to start (`Empty branch` or `Current branch`) only when the session has branchable history. It selects `Empty branch` automatically after 5 seconds unless you press a key; keyboard input pauses the countdown and leaves the selector open for a manual choice. If the working tree has uncommitted changes, the target selector uses the same 5-second behavior to select `Review uncommitted changes`. It then enables review mode and previews the selected review prompt with a 10-second countdown. The prompt is submitted automatically when the countdown ends; press `Esc` to edit it or `Ctrl+C` to stop auto-submit. In either case, the prompt moves into the editor.

For `Empty branch` reviews of uncommitted changes, the extension also generates a change summary from the source branch's session history. The summary loader replaces the editor while generation is in progress. Press `Esc` or `Ctrl+C` to cancel it and continue review startup without a summary. When generation completes, the summary focuses on goal and motivation and is included in the startup prompt, so pressing `Esc` or `Ctrl+C` during the countdown moves both the review request and summary into the editor for adjustment.

When review mode starts and ends, summaries and triage context use target-specific labels such as `current changes`, `changes against 'main'`, `commit abc1234: title`, `PR #42: title`, or `folders: src, docs`.

When the reviewing agent finishes, the extension opens review triage immediately. All comments start as kept, and the triage UI shows a 10-second countdown that accepts them and returns to the original session branch automatically. Press any key to pause automatic acceptance and continue triaging manually; `Ctrl+C` cancels the exit and leaves review mode active. Automatic acceptance forwards all collected comments and asks the agent on the original branch to exercise its judgment about which comments to accept.

If pi is restarted or `/reload` is used during an active review, the original command context cannot be recreated by the extension API. Triage still starts automatically after the next review turn and preserves the accepted result, then prefills `/review`; press `Enter` to complete the return to the original branch without triaging again.

You can also end review mode manually with `/review`. Manual exit opens the same triage without an automatic-accept countdown. If triage is confirmed, it exits review mode, restores model/thinking values captured at start, and posts a summary containing kept comments only. The follow-up prompt is shown with the same 10-second auto-submit countdown; press `Esc` to edit it or `Ctrl+C` to stop auto-submit. If no comments are kept, review mode exits cleanly without posting a summary or follow-up prompt.

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
