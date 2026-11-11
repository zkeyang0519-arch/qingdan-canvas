# Standalone Codex Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a runnable, independently verified local Codex connection program.

**Architecture:** Isolated Node modules implement executable discovery, a read-only stdio client, connection state and a loopback web panel. A portable Windows package includes its runtime and launcher; no existing Qingdan account or Runner state is used.

**Tech Stack:** Node 24 built-ins, plain browser HTML/CSS/JS, node:test.

**Spec:** [Standalone design](D:/TODO/qingdan-canvas/docs/superpowers/specs/2026-11-09-standalone-codex-connector-design.md).

## Global Constraints

- Windows first; current validated Codex protocol version; no model execution or auth credential copying.
- All new product files live under D:/TODO/qingdan-canvas/codex-connector; existing dirty work stays intact.
- Tests and live state stay separate from the existing local Runner.
- Portable package contains runtime/code only, never session histories, diagnostic data or device credentials.

## Review Focus

- Missing/stale/manual executable paths must never launch a wrong candidate silently (Task 1).
- Stalled/malformed/exited stdio processes must time out and clean up, without hanging or leaking children (Task 1).
- Concurrent reconnects and shutdown must not create orphan processes or show stale ready status (Task 2).
- Untrusted origins/Host headers, missing bearer credentials and arbitrary RPC requests must be rejected (Task 2).
- Repeated launch, process crash and package relocation must remain usable without installed Node (Task 3).

### Task 1: Discovery and read-only protocol

Files: codex-connector/discovery.mjs, rpc.mjs, errors.mjs, protocol.json; tests/discovery.test.mjs, rpc.test.mjs, fixture.mjs.

Interfaces: discoverCodex(options) => candidate[]; ReadonlyCodex.connect(), account(), listSessions(query), readSession(id), close(). Request methods are a fixed allowlist.

- [x] Write discovery and real-child-process tests for version/handshake/auth/list/read, Unicode frames, timeouts, bad response and cleanup; run and observe expected missing-implementation failures.
- [x] Implement bounded discovery and read-only JSONL transport with schema checks and owned-child shutdown.
- [x] Run node --test codex-connector/tests/discovery.test.mjs codex-connector/tests/rpc.test.mjs; expect all passing.

### Task 2: Connection manager and usable panel

Files: codex-connector/connector.mjs, server.mjs, public/index.html, public/app.js, public/style.css; tests/connector.test.mjs, server.test.mjs.

Interfaces: Connector.inspect(), listSessions(query), readSession(id), configure(path), diagnostics(), close(); startServer({connector,token,port}) => {server,url,close}.

- [x] Write manager tests for single-flight reconnect, failure classification and shutdown; API tests for auth/origin/Host, validation and diagnostics redaction; observe failures.
- [x] Implement serialized lifecycle with bounded retry, state persistence, protected loopback API and Chinese panel.
- [x] Run all connector tests and browser-script syntax checks; expect all passing.

### Task 3: Launch, packaging and real verification

Files: codex-connector/main.mjs, instance.mjs, package-windows.mjs, README.md; tests/instance.test.mjs; independent verification record.

- [x] Write duplicate/stale/live-instance tests, observe failure, implement safe per-data-directory single instance and shutdown.
- [x] Package code + Node runtime + hidden Windows launcher in codex-connector/release/Codex-Connector-0.1.1-win-x64; no user data. Package test verifies manifest and relocation.
- [x] Run node --test codex-connector/tests/*.test.mjs and real read-only connection/session smoke checks. Verify protected UI and portable launch.
- [x] Obtain one fresh read-only final review, address important findings, rerun affected tests and report observed limitations.

## Execution ledger

Ruling: Work in a new independent subdirectory on the existing feature branch instead of rewriting current Runner or copying its dirty work into another checkout. No existing product files or account state need modification; changes remain separately reviewable.

Ruling: User asked to first make this isolated function work; proceed with native implementation and verification without another plan-approval round.

Ruling: Existing protocol implementation is useful evidence, but the independent package uses a narrow dependency-free client so it can run without the project checkout. Read-only allowlisting is part of its acceptance contract.

Progress: completed and verified on 2026-11-09–10 (Asia/Shanghai), version 0.1.1.

- Fresh final code review found three important lifecycle/packaging defects. Each was reproduced with a failing regression before correction: closing during the version probe, disconnecting while persisting a successful probe, and packaging into a used directory. The reviewed minor search-pagination issue was also reproduced and fixed. No second general review was needed.
- Full isolated suite: `node --test codex-connector/tests/*.test.mjs` — 42 passed, 0 failed, 0 skipped. Includes real fixture child processes and browser-script DOM behavior.
- Real portable smoke: moved package to a Chinese/space-containing path, used bundled Node with system Node removed from PATH, connected to Codex 0.167.0-alpha.3.2, read two pages and a selected project, tested failure recovery/reconnect/duplicate launch, then verified owned processes exited.
- Browser acceptance: ready status and four checks, title search, selected project directory, invalid-path guidance, restore automatic discovery, and exit state were observed in the actual packaged panel. The UI acceptance instance was isolated and shut down.
- Final ZIP: exact 17-file allowlist, source hashes match, bundled runtime hash matches, no user/runtime data. Actual VBS cold start and CMD duplicate launch succeeded from the extracted ZIP; instance shutdown and runtime metadata removal passed.
- Release and evidence: [verification record](D:/TODO/qingdan-canvas/docs/standalone-codex-connector-verification-2026-11-10.md). No existing Qingdan account/device state or product files were modified by this standalone implementation.
