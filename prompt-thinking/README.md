# Prompt Thinking extension

Type `^level` in the editor to pick a thinking level for a single prompt. The control token is removed before the prompt is sent.

## Install

```bash
pi install npm:@siddr/pi-prompt-thinking
```

## Usage

1. Type `^` anywhere in the prompt where whitespace-delimited tokens are allowed.
2. Pick a level from autocomplete.
3. Send the prompt normally.
4. pi temporarily applies that thinking level for the prompt, then restores the previous session level after the response finishes.

### Examples

Typing:

```text
^high summarize the tradeoffs
```

submits as:

```text
summarize the tradeoffs
```

Typing:

```text
Please ^minimal answer briefly
```

submits as:

```text
Please answer briefly
```

## Autocomplete behavior

- Typing `^` opens a thinking-level picker in the interactive TUI.
- The current thinking level is read when the picker opens and preselected when it is available for the active model.
- Up/down arrows move through lower/higher thinking levels because suggestions stay in natural order.
- Available levels depend on the current model:
  - non-reasoning models: `^off`
  - reasoning models: `^off`, `^minimal`, `^low`, `^medium`, `^high`
  - xhigh-capable models: also `^xhigh`

## Token rules

- `^level` can appear anywhere in the prompt as a standalone whitespace-delimited token.
- Matching is case-insensitive (`^HIGH` works).
- Unknown tokens are left unchanged.
- If multiple recognized tokens appear, the first recognized level wins and all recognized `^level` tokens are removed before submission.

## Notes

- The one-prompt behavior is implemented by temporarily changing pi's session thinking level before the prompt runs and restoring the previous level afterward.
- Because pi does not currently expose a true per-turn thinking override API to extensions, this may still append thinking-level-change entries to the session history and briefly update the default thinking setting before it is restored.
- Submit-time stripping works even when custom editor UI is unavailable; autocomplete itself is interactive-TUI only.
