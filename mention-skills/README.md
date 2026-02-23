# mention-skills

Type `$skill-name` in the editor to autocomplete and reference discovered skills by name. On submit, `$skill-name` tokens are replaced with the full path to each skill's `SKILL.md`.

## Install

Symlink into your extensions directory:

```bash
ln -s /path/to/pi-extensions/mention-skills ~/.pi/agent/extensions/mention-skills
```

Then run `/reload` in pi (or restart).

## Usage

1. Type `$` in the editor — autocomplete suggestions appear with all discovered skills.
2. Continue typing to filter (e.g., `$com` matches `$commit`).
3. Select a suggestion to insert the `$skill-name` token.
4. On submit, each `$skill-name` is replaced with the full `SKILL.md` path before the agent sees it.

### Example

Typing:

```
Read $commit before making changes
```

Submits as:

```
Read /Users/you/.agents/skills/commit/SKILL.md before making changes
```

## How it works

- **Skill discovery:** Reads `pi.getCommands()` for entries with `source === "skill"` and a `path`. Refreshes on session start, session switch, and resource discovery.
- **Autocomplete:** A thin `CustomEditor` subclass wraps the autocomplete provider to add `$` mention suggestions. All other editor behavior is delegated unchanged.
- **Input transform:** A `pi.on("input", ...)` handler replaces known `$skill-name` tokens with their full paths. Unknown `$tokens` are left unchanged.

## Limitations

- Only discovered skills (those with a `SKILL.md` path) appear in suggestions.
- `$tokens` that don't match a known skill name are passed through unchanged.
- The `$` trigger requires the `$` to be at the start of a line or preceded by whitespace (same boundary rules as `@` file references).
