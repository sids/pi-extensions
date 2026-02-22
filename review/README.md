# Review extension

Interactive code-review mode for pi.

## What it does

- `/review` toggles review mode:
  - when inactive, it starts review mode
  - when active, it ends review mode
- Supports review targets with parity to the classic `review.ts` flow:
  - uncommitted changes
  - base branch diff
  - specific commit
  - pull request (with `gh pr view` + `gh pr checkout`)
  - folder/file snapshot review
  - custom review instructions
- Supports direct command args:
  - `/review uncommitted` (errors when there are no local changes)
  - `/review branch <name>`
  - `/review commit <sha> [title...]`
  - `/review folder <paths...>`
  - `/review custom [instructions...]`
  - `/review pr <number-or-url>`
- Selector baseline order is:
  - uncommitted (shown only when there are local changes)
  - commit
  - base branch (local)
  - pull request (GitHub PR)
  - folder snapshot
  - custom instructions
- Smart default selector behavior can move one preset to the front while keeping the rest in baseline order:
  - uncommitted (if there are local changes)
  - base branch (if the working tree is clean, you're on a non-default branch, default-branch detection is reliable, and at least one alternate local branch exists)
  - commit (fallback when the base-branch preconditions above are not met)
- Loads project-specific `REVIEW_GUIDELINES.md` from the directory containing `.pi` (if present) and applies those guidelines as hidden review instructions while review mode is active.
- Shows a banner above the editor while active:
  - `Review mode active; /review to exit.`
- Start flow when inactive:
  1. asks where to start review (`Empty branch` or `Current branch`)
  2. asks what to review
  3. for selector flow (`/review` with no args), if target checkout/preparation fails, keeps review start open and asks for target selection again
  4. for direct-arg flow (`/review ...`), if target preparation fails, shows the error and returns you to where you started
  5. enables review mode, injects review instructions as hidden system context, and prefills the editor with the selected review focus so you can edit it (or change model/thinking level) before sending the first review prompt (including for "Custom review instructions")
  6. posts a "Review prompt" message that shows a preview of the hidden instructions and can be expanded with `Ctrl+O` to inspect the full instructions

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

## End-of-review flow

Running `/review` while active:

1. Collects all comments recorded for the active review run.
2. Opens triage UI:
   - keep/discard each comment
   - edit priority (`P0`-`P3`)
   - add optional reviewer note
3. If triage is cancelled, review mode remains active.
4. If confirmed:
   - navigates back to origin when available (no summarize step)
   - deactivates review mode
   - restores model/thinking level to values captured when review mode started (if changed during review)
   - if no review comments were collected, shows an info notification and does not prefill the editor or add a summary message
   - otherwise posts a structured summary message containing only kept comments and prefills the editor to address them

If origin is missing, review mode still finalizes at current tip and warns.
