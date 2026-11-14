# Online Qingdao Implementation Plan

> Use superpowers:executing-plans inline, followed by one fresh final review. The user has authorized the concrete behavior and requested implementation; continue within that scope without another design approval loop.

**Goal:** The online canvas's Qingdao button opens its account and room directly in the desktop capsule.
**Architecture:** PKCE-style native challenge, one-use D1 authorization grant, native-only redemption to a bounded desktop session, existing private native handoff broker, and origin-aware Electron switching.
**Tech Stack:** React, Node 24, Electron 45, Cloudflare Workers/D1, npm.
**Spec:** ../specs/2026-11-14-online-qingdao.md

## Constraints

- Preserve original Agent branch and local-entry-navigation fix; baseline 1570 tests passed.
- No production deployment/migration or real account/device test rebinding. Add an append-only D1 migration and provide manual upgrade instructions.
- No secrets in renderer replies, logs, URLs, argv or persistent local handshake files.
- Keep cloud origins allowlisted, route-specific CORS, HTTPS certificate verification, local Host validation, and production Agent gating.

## Tasks

- [x] Cloud grants: add real Worker/D1 RED tests for authenticated room authorization, single redemption, wrong proof, expiry, source logout and membership removal; add migration 0009 and independent desktop routes; verify GREEN.
- [x] Companion challenge/launch: RED tests for allowlisted origins, CORS, route isolation, proof secrecy, expiry/replay and cancellation; implement bounded in-memory requests and native-only cloud redemption; retain the existing local API.
- [x] Desktop/browser integration: RED tests for origin-aware reuse/switch/rollback, HTTPS cookie security, allowed preload/navigation, complete online button flow, stale UI context and failures. Implement the existing broker/host extensions and direct online launch.
- [x] Isolated browser/native acceptance, full npm test, npm run check, npm run runner:check and npm run deploy:check. Fresh review, address findings, update desktop and deployment documentation. Full-suite intermittent failures and independent reruns are recorded below; no claim of a clean final all-suite run.

## Review Focus

- An attacker-controlled origin, redirect, Host or payload cannot select a command/profile or obtain a desktop session.
- Two redemptions or launches cannot consume one capability twice; disconnects and expiry cannot apply an obsolete context.
- The same account/room IDs on different origins never qualify for reuse; failed switches restore both origin and cookie correctly.
- Unsaved input, offline changes and saving errors retain existing default-cancel behavior.
- HTTPS online-to-loopback requests work with current browser permission rules; neither renderer success nor process spawn alone counts as applied.

## Ledger

- Existing local-only desktop uses a private one-time loopback broker, stdin descriptor and validated renderer receipt. Cloud support will reuse that flow after native redemption.
- Before implementation, the local service was healthy with no active tasks. After acceptance, the lifecycle stop confirmed `interruptedActive: false`; the source launcher was restarted to load the new companion routes. No device binding or account data was replaced.
- Ruling: keep work in the existing Agent checkout as requested earlier, rather than create another development branch/worktree.
- Browser guidance checked: https://developer.chrome.com/docs/modern-web-guidance/guides/security/local-network-access . Loopback fetch uses targetAddressSpace: 'loopback'; permission denial remains visible to the user.
- Independent review found one cancellation race during native navigation/readiness. Added RED regressions, rechecked broker validity after both awaits, restored previous cookies/origin on cancellation, and preserved input on cancelled reuse. Reviewer independently reran the host suite (10 passing) and reported no remaining critical/important findings.
- Error-path acceptance additionally preserves the broker's fixed cancellation and old-client upgrade messages, while arbitrary internal errors remain redacted. RED/GREEN regression added.
- Read-only inspection of the existing Edge canvas confirmed the actual deployed domain is `https://todo.zky.lol` and the original account remained logged in with a synced canvas. Added this exact origin alongside the workers.dev origin, with RED/GREEN checks rejecting lookalike domains, subdomains, HTTP and wildcard configuration.

## Acceptance evidence

- `.tmp/online-qingdao-qa/results.json`: successful isolated browser/native run. Real production-mode Worker and D1 executed grant authorization/redemption; an isolated HTTPS frontend and revision/receipt WebSocket fixture supplied the canvas. A fresh Electron profile received a secure HttpOnly session, opened the same account/room, and kept one always-on-top window with no extra browser page or login.
- Verified native todo creation/completion propagated to the browser, browser completion propagated to the capsule, and a repeated launch preserved unsubmitted input. Screenshots: `.tmp/online-qingdao-qa/online-qingdao-native.png` and `online-qingdao-web.png`. The test CA was trusted only inside the fixture process/partition; no OS/browser trust setting changed.
- All test browser, Electron, HTTPS, companion and Miniflare processes were closed. The user's existing account/profile and Runner binding were not used by the fixture. Browser-to-loopback requests were routed to an isolated random port, so native browser local-network permission still requires an actual published-origin acceptance check.
- `npm test -- --test-concurrency=8`: 1588 passed before the final production-domain addition. Domain/origin, handoff and local API regressions then passed 38/38. A subsequent full run had 1588/1589 pass with one existing `agent-install` runtime.json read failure during its shutdown fixture; that unchanged suite passed 21/21 independently (`.tmp/online-qingdao-install-recheck.log`).
- The lower-concurrency full rerun also had 1588/1589 pass, with the previous failure now passing and a different existing source-launcher test timing out while waiting for fixture ports to be released after a forced process exit (`agent-launcher-process.test.mjs:116`). Its entire file passed 3/3 independently (`.tmp/online-qingdao-launcher-recheck.log`). No desktop/grant tests failed, and no unrelated lifecycle implementation or test timeout was changed. Record these as intermittent full-suite failures, not a clean final full-suite pass.
- `npm run check`, `npm run runner:check`, and `npm run deploy:check`: passed; deploy was a dry run only.
- Deployment instructions updated in `docs/cloudflare-setup.md` and `docs/desktop-island.md`. Remote migration 0009 and production publication remain manual, as required by AGENTS.md; Agent remains disabled online.
- The source service is ready after safe restart (no active tasks or unknown records), with the same Runner connected and polling successfully. Only local migration 0009 was applied by normal startup. Live companion preflight returned 204 for `https://todo.zky.lol` and 403 for an unrelated origin.
- An anonymous native HTTPS request to the actual `https://todo.zky.lol/api/session` returned 200 with the expected session response shape, confirming connectivity and normal certificate validation without using the user's credentials or modifying remote data.
