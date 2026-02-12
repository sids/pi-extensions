# Skill paths extension

Adds two extra skill discovery locations for pi:

- Project: `.agents/skills/`
- User: `~/.agent/skills/`

This is additive. Existing skill locations (such as `.pi/skills/` and `~/.pi/agent/skills/`) continue to work unchanged.

## Usage

Load the extension (for example, symlink this folder into `~/.pi/agent/extensions/skill-paths`) and run `/reload` in pi.

When pi starts or reloads, it will include the directories above if they exist.

## Tests

```bash
bun test skill-paths/tests/utils.test.ts
```
