# Required Registration Email Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Require verified email ownership before a new account and session can be created.

**Architecture:** Add a standalone registration challenge table, reuse the existing email sender and verification primitives, and bind the consumed challenge to the registration transaction. UI collects email and OTP within the existing register form; login remains compatible with legacy accounts.

**Tech Stack:** React, Cloudflare Workers, D1 SQLite, Resend, Node test/JSDOM/Miniflare.

**Spec:** `docs/superpowers/specs/2026-10-23-required-registration-email-design.md`

## Global Constraints

- OTP: 6 digits, 10 minutes, 5 attempts, resend after 60 seconds; share existing mail rate limits.
- No plaintext OTP storage, no real email in tests, no unverified account creation.
- Preserve existing login, invitation, legacy ownership and recovery behavior.
- New migration `0005_registration_email.sql` must precede any later production rollout.

## Review Focus

- Concurrent confirmation or resend must not consume a code twice or transfer legacy data on failed registration (Task 1).
- An already-bound email gets no registration email and the same send response shape (Task 1).
- Switching username/email or mode while requests finish must not leave a usable stale credential (Task 2).
- Failed provider delivery removes the challenge; missing service cannot bypass verification (Task 1).
- Old accounts can still log in and recover after the new migration; registered accounts can recover immediately (Task 3).

### Task 1: Backend and atomic registration

**Files:** `worker/registration.ts`, `worker/accounts.ts`, `worker/email-verification.ts`, `worker/auth-limits.ts`, `worker/email-recovery.ts`, `worker/email-sender.ts`, `worker/index.ts`, `migrations/0005_registration_email.sql`, `tests/registration-email.test.mjs`.

**Interfaces:** `/api/auth/register/request` takes `{username,email}` and returns 202 `{challengeId,retryAfter:60,message}`. `/api/auth/register` additionally requires `{email,code,challengeId}`. Registration HMAC payload is JSON `[id,username,"register",email,code]`.

- [x] Write and run failing behavioral tests for mandatory verification, atomic success, expiry/attempt limits/replay/resend, wrong identity, email uniqueness, failures and races.
- [x] Implement registration challenge request/verification/claim, shared primitives preserving existing bind/reset HMAC payload, migration and guarded transaction statements.
- [x] Run focused backend tests; all new tests and existing recovery tests must pass.

### Task 2: Register form

**Files:** `src/auth/AuthScreen.jsx`, a focused registration component if useful, `tests/account-recovery-ui.test.mjs`, registration UI tests and related styles only.

**Interfaces:** Consume Task 1 endpoints with `accountId:null`; retain the existing auth result and `onAuthenticated` behavior.

- [x] Update tests first: email required, sending/cooldown, code required, payload, stale requests, missing mail service, password mismatch, login/invite/legacy continuity.
- [x] Add email/OTP controls, clear stale proof on identity changes, reuse `useResendCooldown`, show server message and prevent double submits.
- [x] Run focused UI tests and keep existing recovery tests green.

### Task 3: Real Worker integration and completion

**Files:** `tests/integration.test.mjs`, `tests/email-recovery-worker.test.mjs`, `README.md`, `docs/cloudflare-setup.md`.

- [x] Adapt real Worker registration fixtures to valid email proof without external mail, and exercise request/confirm routes with mocked Resend in Miniflare.
- [x] Verify newly registered verified accounts can recover; preserve coverage of unbound legacy accounts, ownership and sessions.
- [x] Update user/setup documentation, run `npm test`, `npm run check`, `npm run deploy:check`, formatting/diff checks, inspect browser form and request a security review.

## Execution Notes

The requirement and existing email flow determine the design; proceed under the user's implementation request. Frontend and integration test work have separate file ownership and can proceed in parallel against the fixed API contract. No production email or database writes are part of development validation.

## Completion Evidence — 2026-10-23

- Backend verification was exercised red-to-green; focused registration and existing recovery tests passed (17/17).
- Registration/recovery UI tests passed (25/25), including stale requests, cooldown and duplicate submission handling.
- Real Worker integration tests passed (17/17), with isolated D1 and mocked email delivery.
- Full `npm test` passed: 265 tests, 0 failures. `npm run check` and `npm run deploy:check` passed.
- Independent security review found no actionable issues in the registration flow, migration, shared recovery helpers or tests.
- Browser validation exercised the email request and cooldown against an isolated local Worker with mocked Resend. No real email was sent.
- Browser validation reproduced a clipped submit button at 1280×720. A scoped `.auth-page` scroll container fixes it; the rebuilt page now scrolls to the complete form and submit button. Final CSS build passed.
- Formatting and whitespace checks are part of the final local verification.
- Apply `0005_registration_email.sql` before production rollout and reuse the existing three email secrets. The user authorized pushing, migrating and deploying this feature after local validation; release results are recorded in `docs/deployment-status.md`.
