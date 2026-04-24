---
name: npm-patch-release
description: Update an npm package patch version, changelog, and lockfile; run relevant tests/checks; commit the release changes; and give the user the exact npmjs publish command without publishing. Use when asked to "update patch version, changelog; commit; give me a command to publish this to npmjs" or similar npm package release-prep tasks.
---

# NPM Patch Release

Perform release prep for an npm package. Do not publish or push unless explicitly asked.

## Workflow

1. Inspect state and identify the target package.
   - Run `git status --short`.
   - Find relevant `package.json` and `CHANGELOG.md` files.
   - If multiple packages could match and the user did not specify one, ask which package to release.

2. Review existing changes.
   - Run `git diff -- <target files>` and include only intended package files.
   - If unrelated or ambiguous changes exist, ask before staging them.

3. Bump the patch version without creating a git tag.
   - For npm workspaces, prefer:
     ```bash
     npm version patch --workspace <workspace-name-or-path> --no-git-tag-version
     ```
   - For a standalone package, run from the package directory:
     ```bash
     npm version patch --no-git-tag-version
     ```
   - Keep lockfiles updated when the command modifies them.

4. Update the package changelog.
   - Add a new top entry under `# Changelog`.
   - Use the new version and current date in `YYYY-MM-DD` format.
   - Summarize user-visible changes concisely.

5. Validate.
   - Run existing tests/checks relevant to the package.
   - Run a packaging dry-run when practical:
     ```bash
     npm pack --workspace <workspace-name-or-path> --dry-run
     ```
     or from a standalone package directory:
     ```bash
     npm pack --dry-run
     ```

6. Commit.
   - Read and follow the commit skill if available before committing.
   - Stage only release-related files: package manifest, lockfile, changelog, docs/code changes being released.
   - Use a concise Conventional Commits subject, usually:
     ```bash
     git commit -m "chore(<package-scope>): release <version>"
     ```
   - Never use `--no-verify`.

7. Report.
   - Include the commit hash, version, validation commands run, and publish command.
   - Give a command only; do not publish.

## Publish Command

For npm workspaces:

```bash
npm publish --workspace <workspace-name-or-path> --access public
```

For standalone packages, from the package directory:

```bash
npm publish --access public
```
