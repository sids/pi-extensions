# Changelog

## 0.1.2 - 2026-05-15

- Migrated runtime imports and peer dependencies to the `@earendil-works/*` Pi 0.74 package scope.
- Updated tool rendering compatibility for the latest Pi runtime package exports.

## 0.1.1 - 2026-04-23

- Registered built-in tool overrides against the active session cwd instead of ambient `process.cwd()`.
- Bound the published Pi peer dependency to Pi 0.68 or newer.

## 0.1.0

- Add compact built-in tool rendering overrides for `read`, `write`, `edit`, `bash`, `grep`, `find`, and `ls`.
