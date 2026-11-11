# Opening Routes Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this approved plan inline. Steps use checkboxes for tracking.

**Goal:** Keep the cover at `/` and make application refresh/navigation stay under `/app`, then merge main.

**Architecture:** A small URL helper centralizes application links and legacy normalization. The gate derives its initial state from the URL, keeps App mounted on entry, and restores route state on popstate. Existing App navigation writes the corresponding application history entries.

**Tech Stack:** React, History API, JavaScript, node:test/jsdom/esbuild; existing Cloudflare SPA fallback.

**Spec:** `docs/superpowers/specs/2026-11-11-opening-routes-design.md`

## Global Constraints

- Use the existing `feat/arranged-project-labels` worktree. Push and main merge are explicitly authorized.
- Preserve preloading, reduced motion, consent, invitation tokens and account/draft isolation.
- No Agent, Worker, schema or new dependencies. Verify with isolated fixtures, not live data.

## Review Focus

- History navigation during pending session/room/invitation/asset operations must invalidate the old destination.
- Legacy and new links must preserve encoded IDs, all query parameters and invite fragments until consumed.
- The opening-to-app transition must keep component identity and request counts stable, including reduced motion and interrupted entry.
- Application navigation and logout must not inadvertently create a cover entry or rewrite the dedicated consent route.
- Refresh/back/forward must restore actual content and saved workspace mode as well as the address.

### Task 1: Separate entry and application navigation

**Files:** Create `src/navigation.js`; modify `src/opening/OpeningGate.jsx`, `src/opening/OpeningCover.jsx`, `src/App.jsx`, `src/CanvasWorkspace.jsx`, `src/api.js`, `src/auth/AuthScreen.jsx`, `src/auth/McpConsent.jsx`, `README.md`; update `tests/opening-cover-ui.test.mjs`, `tests/account-navigation.test.mjs` and `tests/mcp-ui.test.mjs`.

**Interfaces:** `APP_PATH = "/app"`, `isOpeningLocation(url = location) -> boolean`, `appRoomPath(id) -> string`, `normalizeLegacyRoomLocation()`, `enterApplication()`.

- [x] Add regression assertions: entry changes to `/app` without remount/fetch; `/app` and direct room refresh have no cover; old/new invitations survive authentication; history restores landing/list/room; stale destination requests are ignored; internal links/invites target `/app`.
- [x] Run `node --test tests/opening-cover-ui.test.mjs`.
  Expected: route and refresh assertions fail against the existing global cover.
- [x] Implement helpers, gate initialization/history restoration, and application URL updates while preserving existing lifecycle guards.
- [x] Run focused tests and isolated browser checks for actual refresh, restored canvas/arranged mode, native back/forward, slow startup and entry transition.
  Expected: matching content/address, no cover inside `/app`, no duplicate startup on entry, no runtime exceptions.
- [x] Run `npm test`, `npm run check`, `npm run deploy:check`, `git diff --check`.
  Expected: all pass. Full-task test command: `npm test`.
- [ ] Commit and request one fresh read-only whole-change review. Fix material findings in one RED→GREEN pass, then push and merge the verified head.
- [ ] Verify main contains the tested tree and the automatic production build/served assets are updated.

## Verification record

- RED: the route regressions failed against the prior global gate; a separate consent-history regression failed before sharing the destination history lifecycle.
- GREEN: focused opening/account/consent tests pass 45/45; full `npm test` passes 494/494; TypeScript check, production deployment dry run and whitespace check pass.
- Isolated Edge with production assets: native keyboard entry keeps the prepared home and session request count; home, canvas and arranged reloads never mount a cover; native back/forward restores content and mode; a delayed obsolete room response cannot change the restored route.
- Old invitation normalization preserves its encoded query/hash before login, consumes the invitation once, and skips the cover on refresh. Native create/join/list navigation, 375px layout, reduced motion and direct consent login pass with zero runtime exceptions.
- Final review and integration evidence are recorded in the local task ledger and pull request after the implementation commit.
