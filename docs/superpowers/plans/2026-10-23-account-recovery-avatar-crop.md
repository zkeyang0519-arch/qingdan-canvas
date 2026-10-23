# Account recovery and avatar crop implementation plan

> **For agentic workers:** Use superpowers:test-driven-development for each task. Independent avatar work may run through superpowers:dispatching-parallel-agents; the primary agent owns account recovery and integration.

**Goal:** Add verified-email password recovery and an interactive circular avatar cropper.
**Architecture:** Isolated email challenge endpoints and an email sender use existing D1/auth primitives. React forms consume those endpoints. Avatar editing stays in the browser and uploads the confirmed circular bitmap through the existing endpoint.
**Tech Stack:** React 19, Workers, D1, R2, native Canvas, Node test + JSDOM.
**Spec:** ../specs/2026-10-23-account-recovery-avatar-crop-design.md

## Global constraints

- Work in D:/TODO/qingdan-canvas; preserve existing collaboration/identity guards.
- No production deployment or real email sends during development. No secrets committed or printed.
- OTP: six digits, ten minutes, five attempts, sixty-second resend cooldown; HMAC protected storage and single atomic consumption.
- Avatar: 256×256, transparent outside circle, input at most 5 MB.

## Review focus

- Simultaneous resets or password changes cannot replay an old challenge.
- Account switches while async requests finish cannot apply another user's data.
- Unknown identities and delivery failures do not disclose whether an account exists.
- Extreme aspect ratios and zoom bounds do not export pixels outside the circle/image.
- Missing mail configuration does not break existing login, registration or profile UI.

### Task 1: Email challenge backend (primary)

Files: migrations/0004_account_email_recovery.sql; worker/email-recovery.ts; worker/email-sender.ts; worker/types.ts; worker/index.ts; tests/email-recovery.test.mjs.

Interfaces: GET /api/profile/email -> {email, available}; POST /api/profile/email/request {email,currentPassword} -> {challengeId,retryAfter}; POST /api/profile/email/confirm {email,code,challengeId} -> {email}; POST /api/auth/password-reset/request {username,email} -> {challengeId,retryAfter,message}; POST /api/auth/password-reset/confirm {username,email,code,challengeId,password} -> {ok:true}.

- [x] Write behavior tests with a real in-memory SQLite-backed D1 adapter and mocked email transport; verify failures before implementation.
- [x] Implement schema, email sender, validation, throttling, HMAC challenges and atomic binding/reset with session revocation.
- [x] Verify successful and adversarial paths, provider failure, missing configuration and concurrent replay; run node --test tests/email-recovery.test.mjs.

### Task 2: Avatar editor (independent agent)

Files: src/auth/AvatarCropper.jsx; src/auth/avatar-image.js; src/auth/avatar-crop.js; src/auth/avatar-crop.css; src/auth/ProfileSettings.jsx (avatar section only); tests/avatar-crop.test.mjs; tests/task-author-ui.test.mjs (avatar tests only).

Interfaces: Keep ProfileSettings user/onUpdate/onLogout contract and existing avatar PUT endpoint. The agent owns avatar integration; primary waits before adding EmailSettings to that file.

- [x] Write failing tests for explicit crop confirmation, cancellation, resize, drag, zoom and image boundaries.
- [x] Implement circular crop UI and binary export; preserve existing avatar upload failures and account guards.
- [x] Verify unit and component tests. Report commands and evidence; do not commit or deploy.

### Task 3: Recovery forms and configuration (primary)

Files: src/auth/EmailSettings.jsx; src/auth/ForgotPassword.jsx; src/auth/AuthScreen.jsx; src/auth/ProfileSettings.jsx (email integration after Task 2); src/auth/email-settings.css; tests/account-recovery-ui.test.mjs; docs/cloudflare-setup.md; .dev.vars.example.

- [x] Write failing component tests for recovery navigation, password confirmation, email binding and stale requests.
- [x] Implement request/confirm flows, resend countdown, editable/retry states and unavailable-service message; preserve invitation state and login behavior.
- [x] Document verified sender and three variables, migration order, existing-account bootstrap and local mail mock tests.
- [x] Run targeted tests, npm test, npm run check and npm run deploy:check; inspect browser UI and review changes.

## Verification recorded on 2026-10-23

- Final `npm test`: 243 passed, 0 failed. Includes real isolated Worker/D1 routing, mocked mail transport, concurrency and UI regressions.
- `npm run check` and `npm run deploy:check`: passed. The build retains the existing large-chunk warning; the deployment command was a dry run.
- Browser checks at desktop and 390 px width covered recovery navigation, unavailable mail configuration, crop dragging/resizing/zoom, cancellation and confirmed upload. No horizontal overflow at the narrow width.
- A saved test avatar was verified as 256×256 WebP, with transparent corners and opaque circle content.
- Review regressions cover reset lookup timing parity and closing the profile dialog while an avatar upload completes, including account/session switches.
- No production migration, deployment or real email was performed. Production mail delivery still requires the documented sender and secrets configuration followed by a real inbox check.
