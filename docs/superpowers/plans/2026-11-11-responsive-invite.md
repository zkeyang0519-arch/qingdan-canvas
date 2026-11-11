# Responsive Invite Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this single task inline.

**Goal:** Keep the invite button on one line across viewport widths.
**Architecture:** Use CSS breakpoints and presentational spans in the existing shared header. Keep its handler and permissions intact.
**Tech Stack:** React, CSS, npm, existing browser preview.
**Spec:** `docs/superpowers/specs/2026-11-11-responsive-invite-design.md`

## Global Constraints

- Work only in `feat/arranged-project-labels`; preview before main merge.
- No new dependencies, credentials, or remote writes.
- Existing invitation handler and owner permission remain unchanged.

## Review Focus

Check breakpoint boundaries, long project names, hidden-label accessibility, both workspace modes, and narrow-screen overlap. Use actual browser layout checks for this CSS change rather than tests that mirror CSS declarations.

## Task 1: Responsive header

**Files:** `src/CanvasWorkspace.jsx`, `src/app.css`, `src/canvas/arranged.css`.
**Interfaces:** Existing `.share-button`, `.nav-start`, `.nav-end` and view-switch classes; no new application API.

- [x] Reproduce wrapping and overflow in the current browser. At 1024px the invite button is 90px high; at 900px it also extends beyond the viewport.
- [x] Add full/short label spans and a stable accessible name. Apply nonshrinking, fixed-height button styles and compact header rules.
- [x] Build and verify 320–1440px, both sides of breakpoints, a long project title, and both view modes. Expect 36px button height, no text wrapping or header overlap, and accessible invitation action.
- [x] Run `npm test`, `npm run check`, `npm run deploy:check`, formatting and diff checks. Expect all to pass.
- [x] Review, save screenshots, and prepare the change for commit, awaiting the user's visual approval before merge.

## Verification results

- All 459 tests passed; type checking, deployment dry run, formatting, and diff checks passed.
- Real browser: 19 arranged-mode widths from 320 to 1440px and 4 canvas-mode widths; long titles truncate, invite height stays 36px, and header actions do not overlap or overflow. Keyboard focus and the full accessible invite name remain available with hidden text.
- Review identified insufficient space at 1001px with four avatars: 33px available versus 63px needed. Compact header now activates at 1150px; the browser confirms no overlap in compact mode and 101px of spare title space at 1151px for additional avatars and longer sync text.
- Screenshots saved locally for wide, compact, and mobile previews. Preview title and viewport restored after verification. Main merge remains pending the user's approval.
