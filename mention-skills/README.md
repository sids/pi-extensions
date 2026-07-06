# Mention Skills extension

Type `$skill-name` in the editor to autocomplete and reference discovered skills by name. On submit, `$skill-name` tokens are replaced with the full path to each skill's `SKILL.md`.

## Install

```bash
pi install npm:pi-mention-skills
```

## Usage

1. Type `$` in the editor to open discovered skills. On pi versions without natural autocomplete triggers, press **Tab** after `$`.
2. Continue typing to filter (for example, `$com` matches `$commit`).
3. Press **Tab** if needed, then select a suggestion to insert the `$skill-name` token.
4. On submit, each known `$skill-name` is replaced with its full `SKILL.md` path.

### Example

Typing:

```
Read $commit before making changes
```

Submits as:

```
Read /Users/you/.agents/skills/commit/SKILL.md before making changes
```

## Notes

- Skill discovery reads `pi.getCommands()` entries where `source === "skill"` and `path` is present.
- Unknown `$tokens` are left unchanged.
- `$` mention detection follows boundary rules: start of line or preceded by whitespace.
