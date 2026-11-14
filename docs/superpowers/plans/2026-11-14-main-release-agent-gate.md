# Main Release with Agent Development Gate

> Use the existing test-driven-development, executing-plans and finishing-a-development-branch workflows. The user explicitly selected merging all current branch changes while disabling Agent online and keeping development usable.

**Goal:** Merge the current Agent branch, Qingdao and operations work into main with an inert Agent placeholder in published environments.
**Architecture:** The server publishes an Agent capability with authenticated/session responses. Only local/test environments enable it; other environments reject all Agent/Runner/executor routes and keep Agent Durable Objects inert. The UI mounts only the placeholder unless the server explicitly enables Agent.
**Tech Stack:** React 19, Cloudflare Workers/DO, Node 24, Electron 45.

## Constraints

- Original development checkout stays at D:/TODO/qingdan-canvas on feat/qingdan-mcp and remains usable.
- Merge validation checkout: C:/Users/26437/.codex/worktrees/qingdao-main-release/qingdan-canvas.
- Preserve the development branch, local profiles, device bindings and existing production migration history.
- User authorized all current branch changes and a main merge. No production deployment is part of this request; deployment remains the user's manual step per AGENTS.md.
- No secrets, runtime data, .dev.vars, cookies or test profile files may enter the commit.

## Steps

- [x] Add RED regressions for disabled/missing server capability, restored Agent preferences, and production routes/DO entry points with enabled feature flags.
- [x] Implement server policy, guarded DO exports, session capabilities, inert Agent panel, and local-development regression fixtures.
- [x] Verify focused UI/real workerd tests and review the gate independently.
- [x] Run full tests, type check and dry-run deployment; inspect and commit the authorized current branch contents.
- [x] Merge into local main in the isolated checkout, verify the merged result, and preserve the development branch.

## Review Focus

- Production and preview cannot enable Agent by setting old feature flags or changing client storage/query strings.
- Missing capability and restored Agent/batch preferences fail closed, without mounting polling or editing controls.
- Fresh login and same-account focus refresh carry capability correctly.
- Dormant production DO alarms/socket handlers do not reactivate old Agent work or modify its storage.
- Local Agent and desktop account/room handoff remain available.

## Ledger

- Fetch confirmed main and origin/main at 5665bb3 with no divergence. The original checkout has no staged changes and contains authorized Agent/operations/desktop work; a pre-edit diff/status snapshot is retained under .tmp.
- Created a managed isolated main worktree because switching the live development checkout would disturb its running service. The user explicitly confirmed merging all present changes rather than selecting only Qingdao.
- Added production/preview route and DO lifecycle regressions; verified the original implementation failed the new policy checks. Missing/disabled UI capabilities also failed before implementation.
- Independent review found an avatar response that omitted the capability. Fixed both upload/delete responses and verified four environment regressions fail before the fix and pass afterward. The reviewer confirmed the finding is closed with no remaining Important/Critical findings in the release gate.
- Focused verification: 32 tests passed. Type checking and deployment dry-run passed. Isolated browser QA verified the inert Agent screen, no Agent requests or controls, return to canvas, and the Qingdao entry; screenshot/results are in .tmp/main-release-qa.
- First full run passed 1565/1567; the failing anonymous-session assertion and its parent integration test expected the old response shape. Updated the expectation for the new explicit production capability and added real upload/delete response checks. Final full run: 1567/1567 passed, zero failures/skips, 168.9 seconds (.tmp/main-release-full-suite-final.log).
- Commit audit excludes output/ (local generated previews, screenshots, and QA exports), .tmp, .dev.vars and runtime data. Existing output files remain on disk; source, documentation, fonts/licenses, desktop code and tests are included.
- Main integration will preserve the source branch. If the merged application tree is identical to the fully tested source tree, use tree comparison plus focused main-worktree tests/type checking/deployment dry-run rather than repeat the entire unchanged suite.
- Source commits: e5ff81c includes the authorized functional changes and release gate; 062f7b5 fixes a pre-existing standalone test setup assumption by creating node_modules/.cache before mkdtemp. The latter changes only test setup, not application code or assertions.
- Main merged without conflicts. Before this final ledger update, its complete staged tree matched feat/qingdan-mcp exactly. npm ci completed in the isolated main checkout.
- Fresh-checkout validation first found the missing test cache directory. After the source test fix, the merged verification started with no cache directory and passed all 152 tests, including Agent policy, profiles/session refresh, real Worker/D1/R2/DO integration, and desktop launch/handoff/docking/synchronization (.tmp/main-release-merged-tests-final.log).
- Main checkout: npm run check, npm run runner:check, and npm run deploy:check all passed. The last command was dry-run only and confirmed APP_ENV=production with existing feature flags disabled.
- The main merge preserves feat/qingdan-mcp and the original development directory. No remote push, deployment, remote migration, user session change, or device re-binding was performed.
