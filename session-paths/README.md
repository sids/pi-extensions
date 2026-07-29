# Session Paths extension

Find the same pi sessions when a project is checked out under a macOS home directory on one machine and a Linux home directory on another.

The extension treats paths with the same username and suffix as equivalent:

```text
/Users/alex/src/project
/home/alex/src/project
```

## Install

```bash
pi install npm:pi-session-paths
```

## Usage

Start pi and open `/resume`. The project session list includes sessions stored for both equivalent paths. Selecting a session from the other home layout keeps pi in the current working directory instead of trying to use the path recorded on the other machine.

This also works when sessions are stored in a custom session directory.

## Notes

- Usernames must match. `/Users/alex/project` is not equivalent to `/home/sam/project`.
- Only absolute paths below `/Users/<username>` and `/home/<username>` are aliased.
- Session headers and files are not rewritten or moved.
- Startup session lookup (`pi -r`, `pi -c`, and session IDs passed on the command line) happens before extensions load, so it cannot use this alias. Start pi normally and use `/resume` to find a session from the other path layout. An explicit session file path also works.
