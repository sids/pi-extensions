# Answer extension

Interactive Q&A extraction for pi. Run `/answer` to extract questions from the last assistant message, answer them in a TUI, and send the compiled answers back into the chat.

## Usage

1. Trigger with `/answer`.
2. Review each extracted question.
3. If options are available, choose one with **↑/↓** (or **1-9**) or switch to **Other** and type a custom answer.
4. Press **Enter** to commit the current answer and move forward; use **Tab/Shift+Tab** to navigate without committing.
5. On the last question, press **Enter** once to open confirmation and **Enter** again to submit.

Note: The compiled response omits context lines and skips unanswered questions.

Navigation:
- **Tab**: next question (without committing current answer)
- **Shift+Tab**: previous question (without committing current answer)
- **Enter**: commit current answer and move to next question
- **↑/↓**: select an option (when options are present and not editing custom text)
- **1-9**: jump to option number (including Other, when not editing custom text)
- **Type while an option is selected**: switch to custom answer input
- **When editing Other**: clear the custom text, then use **↑/↓** to switch back to options
- **Shift+Enter**: newline in custom answer input
- **Ctrl+T**: apply the next answer template (if configured)
- **Ctrl+C**: cancel
- **Esc** (on submit confirmation): keep editing

## Configuration

The extension reads settings from `~/.pi/agent/settings.json` and `.pi/settings.json` (project overrides global). Add an `answer` block:

```json
{
  "answer": {
    "systemPrompt": "Custom extraction prompt...",
    "extractionModels": [
      { "provider": "openai-codex", "id": "gpt-5.1-codex-mini" },
      { "provider": "anthropic", "id": "claude-haiku-4-5" }
    ],
    "answerTemplates": [
      { "label": "Brief", "template": "{{answer}}" },
      { "label": "Need info", "template": "I need more details about: " }
    ],
    "drafts": {
      "enabled": true,
      "autosaveMs": 1000,
      "promptOnRestore": true
    }
  }
}
```

### Template placeholders

Templates support these placeholders:

- `{{question}}` — current question text
- `{{context}}` — optional context (empty if missing)
- `{{answer}}` — current answer text
- `{{index}}` — 1-based question index
- `{{total}}` — total number of questions

## Draft persistence

Draft answers are saved to the session while you type. When you re-run `/answer` for the same assistant message, the extension can restore the draft (if enabled).

Draft settings:
- `autosaveMs`: debounce interval in milliseconds for saving drafts (`0` saves immediately).
- `promptOnRestore`: prompt before restoring saved drafts when `true` (auto-restore when `false`).

## Acknowledgements

This extension is inspired by the original implementation from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff).

## Tests

Run the utility tests with bun:

```bash
bun test answer/tests/utils.test.ts
bun test answer/tests/qna-adapter.test.ts
```
