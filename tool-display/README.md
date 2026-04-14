# Tool Display extension

Overrides pi's built-in rendering for `read`, `write`, `edit`, `bash`, `grep`, `find`, and `ls` with a more compact TUI layout.

User message rendering is intentionally unchanged.

## Install

```bash
pi install npm:@siddr/pi-tool-display
```

## Local symlink install

```bash
ln -s /Users/sid/src/pi-extensions/tool-display ~/.pi/agent/extensions/tool-display
```

Then run `/reload` in pi.

## Behavior

- `read`: collapsed shows `loaded N lines`; expanded shows syntax-highlighted text. Image reads keep their attachment display.
- `write`: collapsed shows up to 10 lines from the written content; expanded shows the full content.
- `bash`: collapsed shows up to 10 lines of output; expanded shows the full visible output.
- `edit`: always shows diff stats and the unified diff.
- `grep`, `find`, `ls`: collapsed shows counts only; expanded shows the full output.
- Limit/truncation notices are preserved in collapsed and expanded views.

## Notes

- This extension only changes tool display. It does not change tool behavior.
- The overridden tools still delegate execution to pi's built-in implementations.
