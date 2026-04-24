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
- `write`: collapsed shows up to 10 dimmed lines from the written content; expanded shows the full dimmed content.
- `bash`: shows a more OpenCode-style running/failed preview, with non-error output dimmed, collapsed output capped at 10 lines, and a `Ctrl+O` hint to see the full output.
- `edit`: always shows a richer remote-style diff with diff stats and tinted change rows, and supports pi's current `edits[]` call shape.
- `grep`, `find`, `ls`: collapsed shows counts only; expanded shows the full output.
- Limit/truncation notices are preserved in collapsed and expanded views.

## Notes

- This extension only changes tool display. It does not change tool behavior.
- The overridden tools still delegate execution to pi's built-in implementations.
- It restores the existing active tool list after registering overrides, so it does not turn on extra built-in tools like `grep`, `find`, or `ls` by itself.
