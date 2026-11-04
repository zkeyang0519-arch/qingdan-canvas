# Readable project names and Codex instructions

User request: name newly created folders in Qingdan and send clear natural-language instructions to Codex instead of the complete dispatch request. Execute inline on the existing `feat/qingdan-mcp` workspace; base `3e910a4`. This is the approved user-facing change, not a new approval gate.

## Contract

- New project creation exposes `项目名称`, default `轻单测试项目`. The name is the actual final directory component and registered display name. Trim/NFC normalize, 1–60 UTF-16 characters, reject path separators, control characters, Windows reserved names, leading dots and trailing dots. No arbitrary browser path.
- Named projects live under `.tmp/execution-projects/<owner-hash>/<name>`. Preserve account isolation, symlink/Git redirection checks and same-name file reuse. Legacy no-name API calls keep the old `.tmp/execution-trial/<owner-hash>` behavior. Never rename/move old folders or existing Codex history.
- Each named workspace gets its own `agent-execution-project-<workspaceId>` section/binding. Named options return through authenticated local status; old bindings/history remain selectable. Switching names cannot overwrite a previous project's binding.
- Codex user messages contain task/instructions, acceptance criteria and necessary readable context. Summary is explicitly read-only; follow-ups contain the new clarification. No snapshot/owner/binding/hash/request/run envelope in user messages.
- Keep `clientUserMessageId`, local pending IDs, snapshots and all recovery guards unchanged. Task model output contains business result fields; Runner supplies authoritative run/task IDs. Legacy structured results remain accepted only with matching IDs. Unknown/malformed output still cannot become success.
- Remove run UUID from generated chat titles. Keep IDs in actual API/state. Do not claim new desktop automatic grouping as part of this change.

## Tasks

Review focus: Windows name/symlink boundaries and owner isolation; distinct project bindings and malformed/stale responses; readable prompts retaining acceptance/context while excluding authority data; business-result ID hydration without accepting foreign legacy IDs; local failures and account changes preserving the right project options.

### 1. Human-readable prompts and results

Files: `runner/prompt.ts`, `runner/codex-adapter.ts`, `tests/runner-codex.test.mjs`, `tests/fixtures/fake-codex.mjs`.

- [x] Add failing tests for natural task/summary/follow-up input, required context and acceptance preservation, absence of internal envelope data, readable titles, authoritative ID hydration and rejection of foreign legacy IDs.
- [x] Render plain-language instructions; omit runId/taskId from model output schema; validate/hydrate business results at the adapter boundary. Fake model produces output according to the supplied output schema, not by parsing prompt JSON.
- [x] Run native adapter/executor regression including lost-response recovery and continuation; `npm run runner:check`.

### 2. Named project preparation and selection

Files: `scripts/lib/execution-trial.mjs`, `scripts/lib/local-runner-api.mjs`, `scripts/dev-agent.mjs`, `src/agent/ExecutionPanel.jsx`, relevant helper/API/UI tests.

- [x] Add failing tests for Chinese folder names, invalid names/traversal/devices, same-name preservation, separate accounts/projects, symlink rejection, API authentication, project-name submission and independent binding/selection after refresh.
- [x] Add optional `projectName` to prepare helper/API. Add named project listing to local status. Preserve legacy operation and create a unique section for each named workspace.
- [x] Add name input and create action, readable selection labels and expandable physical path. Keep former projects/history; guard stale account/selection responses.
- [x] Run helper/API/UI tests and type checks.

### 3. Integration and acceptance

- [x] Stop only the verified owned local launcher before broad checks. Run `npm test`, `npm run check`, `npm run runner:check`, `npm run deploy:check` in isolated state.
- [x] Fresh whole-change review under executing-plans; fix evidenced important defects and rerun affected checks.
- [x] Restart actual-user launcher hidden. Create a named test project through Qingdan, submit a natural-language file task, continue the same chat, verify files and persisted input/title; reload and select both new and legacy projects.
- [x] Record actual results, screenshot and local commit; retain usable app. No production deployment.

Acceptance completed: 591/591 full tests, both type checks, deploy dry run and fresh review passed. Real Qingdan UI created a Chinese-named directory, ran a file task and same-chat follow-up, preserved same-name contents, created an independent second binding, and restored new/legacy history after reload. Actual Codex user messages contain natural instructions without the dispatch envelope. See [verification record](../../agent-readable-dispatch-verification-2026-11-04.md).
