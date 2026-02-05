# AGENTS

## Project overview

This repository contains the **answer**, **fetch-url**, and **web-search** pi extensions.

## Key files

- `answer/index.ts`: Extension entry point
- `answer/utils.ts`: Shared helpers
- `answer/README.md`: Usage/config docs
- `answer/tests/utils.test.ts`: Unit tests
- `fetch-url/index.ts`: Extension entry point
- `fetch-url/utils.ts`: Shared helpers
- `fetch-url/README.md`: Usage/config docs
- `fetch-url/tests/utils.test.ts`: Unit tests
- `web-search/index.ts`: Extension entry point
- `web-search/utils.ts`: Shared helpers
- `web-search/README.md`: Usage/config docs
- `web-search/tests/utils.test.ts`: Unit tests

## Adding new extensions

1. Create a new directory under the repo root (e.g., `my-extension/`).
2. Add an `index.ts` entry point.
3. Document usage in `my-extension/README.md`.
4. Add tests under `my-extension/tests/` (when applicable).

## Development notes

- Always add/update tests when making changes.
- Always run tests after making changes.
- Run tests with:
  ```bash
  bun test answer/tests/utils.test.ts
  bun test fetch-url/tests/utils.test.ts
  bun test web-search/tests/utils.test.ts
  ```
- To load an extension locally, symlink its directory into `~/.pi/agent/extensions/<name>` and run `/reload` in pi.
