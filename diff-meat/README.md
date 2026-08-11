# pi-diff-meat

Source-anchored browser reading diffs for pi, inspired by [meat](https://github.com/boldsoftware/meat) and powered by [Plannotator](https://github.com/backnotprop/plannotator).

## Install

```bash
pi install npm:@siddr/pi-diff-meat
```

## Commands

- `/diff-meat [target]` — abridges the selected diff, then opens the result in Plannotator.

Supported targets:

- `uncommitted`
- `branch <name>`
- `commit <sha>`

Examples:

```text
/diff-meat uncommitted
/diff-meat branch main
/diff-meat commit abc123
```

With no arguments, uncommitted changes are selected automatically when present. Otherwise, the extension opens an interactive target picker. Untracked files and repositories without a first commit are supported.

## How it works

The extension numbers the immutable original patch and asks the configured model for a structured edit plan:

- `remove` hides complete original lines.
- `fold` mechanically replaces a contiguous, same-marker range with an indentation-preserving `...` line.
- `replace` permits only local elisions that preserve exact source text around `...` or `…`.
- `drop_files` removes complete generated or mechanical files.

Every operation is validated for coordinates, overlap, diff structure, and source fidelity. The model never authors replacement code. Hunk headers are regenerated after abridgement, and omitted ranges are split into correctly positioned hunks so Plannotator annotations keep the original old/new source coordinates.

For uncommitted changes, the model receives the active session’s user/assistant text as intent context; tool calls, tool results, thinking, and non-conversation entries are excluded. Branch comparisons receive the messages for commits unique to `HEAD`, while commit reviews receive the selected commit’s message.

Large diffs are split using conservative token estimates at file and hunk boundaries. Hunks from the same file and exact multi-line moves are kept together when the model context permits; asymmetric move edits are discarded so both sides remain truthful. When token limits require multiple chunks, a final global pass removes cross-chunk repetition and writes one coherent summary.

For trusted projects, the model can selectively use confined, read-only `read_file` and `grep` tools to inspect surrounding source. In TUI mode, generation runs in a cancellable loader. Progress reports the current phase and token usage.

Results are cached by patch, conversation or commit context, model, reasoning level, retention policy, source-inspection mode, and abridgement protocol. The cache is stored under `$XDG_CACHE_HOME/pi-diff-meat` or `~/.cache/pi-diff-meat`.

Plannotator provides the browser, annotations, approval flow, and feedback handoff to the agent. Diff abridgement remains a blocking, cancellable generation step. Once it completes, the Plannotator review runs asynchronously so pi remains responsive while the browser is open. Requested changes can be submitted at any time and are sent to the agent as steering. Browser launching follows `PLANNOTATOR_BROWSER`, `PLANNOTATOR_REMOTE`, and `PLANNOTATOR_PORT`.

## Configuration

Defaults use `openai-codex/gpt-5.6-luna` with high reasoning.

| Environment variable | Default | Description |
|---|---|---|
| `DIFF_MEAT_MODEL` | `openai-codex/gpt-5.6-luna` | Model in `provider/model` format |
| `DIFF_MEAT_THINKING` | `high` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |
| `DIFF_MEAT_RETENTION` | `balanced` | `light`, `balanced`, or `aggressive` |
| `DIFF_MEAT_MAX_CHUNK_TOKENS` | `120000` | Token budget per chunk, from 8,000 to 500,000 |
| `DIFF_MEAT_SOURCE_INSPECTION` | `true` | Enable confined source tools in trusted projects |
| `DIFF_MEAT_CACHE` | `true` | Enable content-addressed result caching |

Example:

```bash
DIFF_MEAT_MODEL=opencode-go/gpt-5.6-luna \
DIFF_MEAT_THINKING=xhigh \
DIFF_MEAT_RETENTION=aggressive \
pi
```

## Local development

```bash
pnpm install
pnpm --filter @siddr/pi-diff-meat test
```

To load locally, symlink `diff-meat/` into `~/.pi/agent/extensions/diff-meat` and run `/reload` in pi.
