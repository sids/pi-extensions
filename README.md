# pi-extensions

A collection of pi extensions. Each extension lives in its own directory with its own README and tests.

## Repository layout

- `answer/` – Interactive Q&A extraction and answering extension

## Loading an extension locally

Symlink a directory into `~/.pi/agent/extensions/` and reload pi:

```bash
ln -sfn /path/to/pi-extensions/answer ~/.pi/agent/extensions/answer
```

Then in pi:

```
/reload
```

## Tests

Each extension manages its own tests. Example:

```bash
bun test answer/tests/utils.test.ts
```
