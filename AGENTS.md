# AGENTS

## Project overview

This repository contains the **answer** pi extension in `answer/`.

## Key files

- `answer/index.ts`: Extension entry point
- `answer/utils.ts`: Shared helpers
- `answer/README.md`: Usage/config docs
- `answer/tests/utils.test.ts`: Unit tests

## Adding new extensions

1. Create a new directory under the repo root (e.g., `my-extension/`).
2. Add an `index.ts` entry point.
3. Document usage in `my-extension/README.md`.
4. Add tests under `my-extension/tests/` (when applicable).

## Development notes

- Run tests with:
  ```bash
  bun test answer/tests/utils.test.ts
  ```
- To load the extension locally, symlink the `answer/` directory into `~/.pi/agent/extensions/answer` and run `/reload` in pi.
