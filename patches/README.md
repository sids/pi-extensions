# Dependency patches

`@plannotator/pi-extension@0.27.6` is patched to keep embedded review sessions quiet and local:

- known first-run and feature-announcement cookies are seeded before the browser application starts;
- submitting or approving all recorded feedback requires Cmd/Ctrl+Alt+Enter instead of Cmd/Ctrl+Enter, including in the keyboard shortcut help;
- the bundled latest-release URL is rewritten to local `data:` metadata before the HTML response is sent, so the update hook never contacts GitHub and the global `fetch` function remains untouched.

Plannotator versions its announcement cookies. Review the cookie names and values whenever the dependency is upgraded, then regenerate the patch with `pnpm patch` and `pnpm patch-commit`.
