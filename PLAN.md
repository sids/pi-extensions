# Pi 0.80.6 → 0.83.0 extension update plan

## Context

The workspace has 17 Pi extensions plus `shared`. Root development dependencies are pinned to Pi 0.80.6, every published package advertises Pi `>=0.80.6`, and the lockfile resolves TypeBox 1.1.38. The target is the only published 0.83 release, 0.83.0; retaining 0.80 compatibility is not required.

The authoritative lockstep changelogs for `pi-coding-agent`, `pi-agent-core`, `pi-ai`, and `pi-tui` were reviewed from 0.80.7 through 0.83.0. Relevant changes are:

- 0.80.8 replaced SDK `createAgentSession({ authStorage, modelRegistry })` with `modelRuntime`, while retaining `ModelRegistry` as an extension compatibility facade.
- 0.81 added root lifecycle type exports and `contentText()`.
- 0.82 added preferred/required constrained sampling for tool schemas.
- 0.82.1 exposed `outputPad` to custom message renderers.
- 0.83 added `ctx.scopedModels`, a `pending` stop reason for partial messages, and TypeBox 1.3.7.
- The reviewed 0.80 patch releases also added `agent_settled`, dynamic tool activation, and per-tool execution modes.

No extension uses the TypeBox APIs removed in 1.3.7, and the current 708-test suite passes on the existing 0.80.6 dependency set. The one definite compile-time break is `side/side-session.ts`, which still supplies the removed session-creation options.

### Impact and priority

| Extension/package | Priority | Planned impact |
| --- | --- | --- |
| `side` | Required + recommended | Migrate child session creation to `ModelRuntime`; mirror effective parent providers; honor `ctx.scopedModels`; type child lifecycle events; add preferred schema constraints. |
| `task-subagents` | Recommended | Replace settings-file/CLI re-parsing and private `dist/core/model-resolver.js` loading with `ctx.scopedModels`, preserving model-pinned thinking levels in launch review; add preferred schema constraints. |
| `plan-md` | Recommended | Honor renderer `outputPad`; add preferred schema constraints; make `request_user_input` sequential so sibling calls cannot open concurrent dialogs. |
| `review` | Recommended | Honor renderer `outputPad`; add preferred schema constraints; forward provider-scoped auth environment for summary calls. |
| `status` | Recommended | Treat `agent_settled`, not each low-level `agent_end`, as the end of an agent timing interval so retries/compaction/queued continuations remain one run. |
| `cmux-status` | Recommended | Stay `Working` until `agent_settled` instead of briefly becoming ready between continuations/retries. |
| `answer` | Recommended | Forward provider-scoped auth environment and use Pi's `contentText()` helper for assistant/extraction text. |
| `fetch-url`, `web-search` | Optional, low risk | Opt their closed TypeBox schemas into preferred strict JSON-schema sampling. |
| `cache-expiry-warning`, `diff-review`, `mention-skills`, `openai-params`, `prompt-save`, `prompt-thinking`, `session-paths`, `tool-display`, `shared` | Dependency/release only | No 0.83-facing source migration is justified; smoke-test them against the new runtime. |

Dynamic tool loading does not justify a change: mode tools are activated before a model request rather than discovered from a loader-tool result. The new partial `pending` stop reason also needs no behavior change because finalized-message checks already operate on `message_end`, while the side transcript treats streaming messages as partial regardless of their stop reason.

## Approach

1. Upgrade the workspace runtime to Pi 0.83.0 and TypeBox 1.3.7, then run the existing suite before feature refactors so dependency regressions are isolated.
2. Fix the `side` SDK break by creating a canonical `ModelRuntime`, registering the effective providers exposed by the parent `ModelRegistry`, refreshing without unnecessary network work, and passing that runtime to `createAgentSession`. Use the parent's scoped-model snapshot when present and all available models only when the scope is empty.
3. Adopt 0.83 extension surfaces where they remove workarounds or fix observable behavior: `ctx.scopedModels`, renderer `outputPad`, `agent_settled`, provider auth `env`, exported lifecycle types, and `contentText()`.
4. Add `{ type: "json_schema", strict: "prefer" }` only to extension-owned, closed object schemas. Keep fallback behavior on unsupported models; do not force strict sampling or alter Pi's overridden built-in tools.
5. Patch-release every package because every published peer range changes to `>=0.83.0`; include source-specific changelog entries only where behavior changed.

## Files to modify

### Workspace and releases

- `package.json`, `pnpm-lock.yaml`: Pi `^0.83.0`, TypeBox `^1.3.7`, regenerated dependency graph.
- `diff-review/bun.lock`: regenerate the standalone lock against Pi 0.83.0.
- Every workspace `*/package.json`: raise Pi peers to `>=0.83.0` and increment the package patch version for republishing.
- Every workspace `*/CHANGELOG.md`: record the Pi 0.83 minimum; add relevant behavior/API notes for source-updated packages.

### Source and focused tests/docs

- `side/side-session.ts`, `side/summary.ts`, `side/parent-session.ts`
- `side/tests/construction.test.ts`, `side/tests/side-session.test.ts`, `side/tests/summary.test.ts`, `side/tests/parent-session.test.ts`, `side/README.md`
- `task-subagents/launch-tui.ts`, `task-subagents/subagents.ts`
- `task-subagents/tests/launch-tui.test.ts`, `task-subagents/tests/subagents.test.ts`, `task-subagents/README.md`
- `plan-md/index.ts`, `plan-md/request-user-input.ts`, and their focused tests
- `review/index.ts`, `review/comments.ts`, `review/change-summary.ts`, and their focused tests
- `status/index.ts` and timing/event tests under `status/tests/`
- `cmux-status/index.ts`, `cmux-status/tests/index.test.ts`
- `answer/index.ts`, `answer/tests/index.test.ts`
- `fetch-url/index.ts`, `fetch-url/tests/index.test.ts`
- `web-search/index.ts`, `web-search/tests/index.test.ts`

README edits are limited to user-visible model-scope behavior in `side` and `task-subagents`; dependency-only packages need changelog/manifests but no source or README churn.

## Reuse

- `ModelRuntime`, `ModelRegistry.getProvider()`, and `createAgentSession()` from `@earendil-works/pi-coding-agent` for the side-session migration; do not create a parallel auth abstraction.
- `ctx.scopedModels` for both side-chat and subagent model lists; its empty-list semantics already mean “all authenticated models.”
- `contentText()` from `@earendil-works/pi-ai` instead of local text-block filter/map/join copies.
- Existing extension schemas in `fetch-url/index.ts`, `web-search/index.ts`, `plan-md/schemas.ts`, `review/schemas.ts`, and `task-subagents/schemas.ts`; add metadata rather than duplicate schemas.
- Existing extension-local fakes and event harnesses for all regression tests.
- Root checks `scripts/check-peer-runtime.js` and `scripts/check-package-boundaries.js`.

## Steps

- [x] Raise root Pi dependencies to `^0.83.0`, pin TypeBox development resolution to `^1.3.7`, install once, and regenerate `pnpm-lock.yaml` plus `diff-review/bun.lock`.
- [x] Raise all package Pi peers to `>=0.83.0`; increment patch versions and seed changelog entries for the coordinated release.
- [x] Migrate `side` to an explicit `ModelRuntime`, mirror effective parent providers, pass parent scope entries (including pinned thinking), and make model selection/cycling use that same scoped list.
- [x] Type `SideSessionController` subscriptions with Pi's exported `AgentSessionEvent`, retain partial-message handling for the 0.83 `pending` state, and replace touched text extraction helpers with `contentText()`.
- [x] Simplify `task-subagents` model candidate discovery to `ctx.scopedModels` with all-available fallback; remove direct settings reads, CLI parsing, trust checks, and private module loading used only for scope reconstruction; carry pinned thinking into per-task launch defaults.
- [x] Pass `outputPad` into every `plan-md` and `review` custom message `Text`/`Box` renderer and add tests with non-default padding.
- [x] Mark extension-owned tools in `fetch-url`, `web-search`, `plan-md`, `review`, `task-subagents`, and `side` as strict-preferred; close the side parent-tool object schemas with `additionalProperties: false`; mark `request_user_input` as sequential.
- [x] Move `status` run finalization and `cmux-status` ready/error transition to `agent_settled`, preserving `agent_end` only where low-level accounting is genuinely needed; test retry/continuation sequences.
- [x] Forward `env` from `ModelRegistry.getApiKeyAndHeaders()` in `answer` and `review` model calls, and use `contentText()` in touched answer/review/side/subagent extraction paths without changing separators or trimming.
- [ ] Update the two affected READMEs and all package changelogs, then perform the coordinated patch release only after verification. (Docs/changelogs and the 18-package publish dry run are complete; registry publication is blocked by missing npm authentication.)

## Verification

- Run focused tests for each source-updated package, then `pnpm test` (baseline: 81 files / 708 tests).
- Run `pnpm run check:peer-runtime` and `pnpm run check:package-boundaries`; run `pnpm --filter @siddr/pi-diff-review build` and its package tests.
- Confirm all lockfile Pi entries resolve to 0.83.0 and TypeBox resolves compatibly to 1.3.7; verify packed manifests contain `>=0.83.0` peers and no bundled Pi runtime copies.
- In Pi 0.83.0, manually verify:
  - `/side` starts, summarizes, streams, uses built-in and extension-registered providers, and cycles only through scoped models with pinned thinking respected.
  - `subagents` launch review mirrors `/scoped-models`, including CLI/settings scopes and unscoped fallback.
  - plan/review messages respect at least two `outputPad` settings, and multiple `request_user_input` calls do not overlap.
  - strict-capable and fallback models can call every newly annotated tool.
  - status and cmux remain active through an auto-retry or compaction retry and settle exactly once.
  - answer/review summaries work with API-key, header-only, and provider-env/ambient auth where available.
- Smoke-test dependency-only extensions in Pi 0.83.0: load/reload, invoke their command or shortcut/tool, switch model/session where relevant, and check for runtime/type-loading errors.
