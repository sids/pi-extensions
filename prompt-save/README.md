# Prompt Save extension

Save useful prompts from the editor, restore them later from a picker, and copy them to the system clipboard.

## Install

```bash
pi install npm:pi-prompt-save
```

## Usage

- `Alt+S`: save the current editor text, clear the editor, and keep it in the current session's saved-prompt list.
- `Alt+Shift+S`: open the saved-prompt picker.
- `Ctrl+Alt+C` in the editor: copy the current editor text to the system clipboard and clear the editor after the copy succeeds.

## Picker controls

- `Enter`: insert the selected saved prompt into the editor. If the editor already has text, the prompt is appended with a single newline separator.
- `Ctrl+Alt+C`: copy the selected saved prompt to the clipboard without deleting it.
- `Ctrl+D`: remove the selected saved prompt from the session-wide list shown by the picker.
- `Esc`: close the picker.

The picker shows its shortcuts inline in the footer row.

## Persistence

Saved prompts are persisted in the current pi session and are visible across all branches in that session.

Removing a saved prompt takes it out of the picker list, but it does not erase prompt text already recorded in the underlying pi session history.
