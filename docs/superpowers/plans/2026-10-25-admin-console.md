# 轻单管理员后台 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为现有轻单增加受服务端保护的 `/admin` 账号管理后台，支持 `moon` 主管理员和受控的管理员授权、资料修改、代改密码及停用/恢复。

**Architecture:** 在现有 D1 `accounts` 表上增加 `role` 与 `disabled_at`，把管理员授权集中到新的 `worker/admin.ts`，由 `worker/index.ts` 分派 `/api/admin/*`。沿用当前 Cookie 会话、`X-QD-Account`、同源检查和 scrypt 密码哈希；React 在现有 SPA 内按 `/admin` 路径渲染独立页面，普通画布不改权限模型。

**Tech Stack:** Cloudflare Workers + D1 + Durable Objects + TypeScript；React 19、Vite、现有 `api()` 封装；Node `node:test`、Wrangler Miniflare、本地 D1/DO/R2 集成测试。

**Spec:** `docs/superpowers/specs/2026-10-24-admin-console-design.md`

## Global Constraints

- 密码校验沿用当前 9–128 字符规则和 `worker/passwords.js` 的 scrypt 编码格式（`N=16384`、`r=8`、`p=5`）。
- 不保存或返回明文密码，不新增全局盐；每次改密调用 `hashPassword` 生成独立随机盐。
- `moon` 是受保护主管理员；其他管理员不能修改其资料、密码、角色或停用状态。
- 不删除账号；停用保留画布、成员、头像和作者关系。
- 所有管理员权限必须由 Worker 服务端检查，不能依赖隐藏前端按钮。
- D1 迁移先于线上代码发布；本轮只做本地测试和 dry-run，不执行生产迁移或部署。

## Review Focus

- 旧 Cookie、旧 WebSocket 在管理员改密或停用后必须失效；测试归入任务 2 的会话撤销用例。
- 并发提权/降权/停用不能移除最后一个管理员；测试归入任务 2 的 D1 原子更新用例。
- `moon` 的所有后台变更都必须被拒绝，且后台行不能显示可执行危险操作；测试归入任务 2 和任务 3。
- 管理员替换或清空邮箱时，旧邮箱挑战不能继续找回密码；测试归入任务 2 的邮箱一致性用例。
- 直接访问 `/admin`、登录后路径保留以及失去管理员权限后的返回行为必须稳定；测试归入任务 3 的路由用例。

## 文件地图

- Create: `migrations/0006_admin_accounts.sql` — 账号角色与停用状态迁移，并提升已存在的 `moon`。
- Create: `worker/admin.ts` — 管理员鉴权、账号列表、资料/密码/角色/状态管理接口。
- Modify: `worker/types.ts` — `Session`、账号公开资料与管理员记录类型。
- Modify: `worker/auth.ts` — 查询角色与停用状态、公开会话角色、拒绝停用会话。
- Modify: `worker/accounts.ts` — 登录时拒绝停用账号，并沿用密码校验。
- Modify: `worker/index.ts` — 分派 `/api/admin/*`。
- Create: `src/AdminPage.jsx` — `/admin` 列表、编辑、改密、提权/降权、停用/恢复页面。
- Create: `src/admin.css` — 管理后台响应式样式。
- Modify: `src/App.jsx` — 路径路由、管理员入口、失权返回首页。
- Create: `tests/admin-worker.test.mjs` — 真实 Worker/D1/DO 管理接口测试。
- Create: `tests/admin-ui.test.mjs` — React 页面和请求交互测试。
- Modify: `docs/cloudflare-setup.md`、`README.md` — 迁移顺序、`moon` 尚未存在时的一次性初始化 SQL、管理员安全说明。

### Task 1: Add role/status schema and session identity

**Files:**
- Create: `migrations/0006_admin_accounts.sql`
- Modify: `worker/types.ts`
- Modify: `worker/auth.ts`
- Modify: `worker/accounts.ts`
- Test: `tests/admin-worker.test.mjs`

**Interfaces:**
- Produces `Session.role: 'user' | 'admin'` and nullable `disabled_at` storage semantics for the admin API.
- `publicUser()` includes `role` as the frontend-visible authorization hint; the Worker remains authoritative.

- [ ] **Step 1: Write failing migration/session tests**

  In `tests/admin-worker.test.mjs`, create the same Miniflare/D1 fixture pattern used by `tests/email-recovery-worker.test.mjs`. Apply all migrations, insert a `moon` account and a normal account using `hashPassword`, then assert that the migration adds `role`, `disabled_at`, promotes only `moon`, and that `/api/session` returns `user.role`.

- [ ] **Step 2: Run the focused test and verify it fails**

  Run: `node --test tests/admin-worker.test.mjs`

  Expected: FAIL because migration `0006_admin_accounts.sql` and role-aware session queries do not exist.

- [ ] **Step 3: Implement the schema and session changes**

  Add `role` with default `user` and a check constraint, add nullable `disabled_at`, and update existing `moon` rows. Extend `Session` and account row types. Make `getSession()` select `role` while filtering `disabled_at IS NULL`; make `publicUser()` return `role`. In the login branch of `accountEndpoint`, reject accounts with `disabled_at` set before verifying/creating a session. Do not change the scrypt implementation.

- [ ] **Step 4: Run focused tests and verify they pass**

  Run: `node --test tests/admin-worker.test.mjs`

  Expected: schema and session identity assertions pass; existing password and session tests remain green.

- [ ] **Step 5: Commit the schema/session slice**

  ```powershell
  git add migrations/0006_admin_accounts.sql worker/types.ts worker/auth.ts worker/accounts.ts tests/admin-worker.test.mjs
  git commit -m "feat: add account roles and disabled state"
  ```

### Task 2: Build and secure the admin Worker API

**Files:**
- Create: `worker/admin.ts`
- Modify: `worker/index.ts`
- Modify: `worker/auth.ts` (only if the shared `requireAdmin` helper belongs there)
- Modify: `worker/email-recovery.ts` (only to expose the existing email normalizer or shared challenge invalidation helper)
- Test: `tests/admin-worker.test.mjs`

**Interfaces:**
- Produces `requireAdmin(request, env): Promise<Session>` and `adminEndpoint(request, env, action, accountId?)` for `worker/index.ts`.
- Routes:
  - `GET /api/admin/accounts`
  - `PATCH /api/admin/accounts/:id`
  - `POST /api/admin/accounts/:id/password`
  - `POST /api/admin/accounts/:id/role`
  - `POST /api/admin/accounts/:id/status`

- [ ] **Step 1: Add failing API tests before implementation**

  Extend the Miniflare fixture with cookies for `moon`, a second admin, a normal account, and a disabled account. Cover:

  - unauthenticated and normal-user requests return 401/403 without account data;
  - `moon` sees the list but no `password_hash`, session token, or recovery credential;
  - admin can change a normal user’s name/email, set a new password, promote/demote, and disable/restore;
  - password reset stores a different encoded scrypt hash, removes all target sessions, and lets the new password log in while the old one fails;
  - disabling removes sessions and blocks login, `/api/session`, snapshot and WebSocket access; restoring requires a fresh login;
  - `moon` cannot be edited, reset, demoted, or disabled by another admin; an admin cannot self-demote/self-disable;
  - the last admin cannot be demoted or disabled, including two concurrent mutation requests;
  - replacing or clearing an email removes pending `email_challenges` and handles unique email conflicts with 409.

- [ ] **Step 2: Run focused API tests and verify they fail**

  Run: `node --test tests/admin-worker.test.mjs`

  Expected: FAIL with missing `/api/admin/*` routes and missing `requireAdmin`.

- [ ] **Step 3: Implement `worker/admin.ts` and route dispatch**

  `requireAdmin` must call `requireSession`, verify `role === 'admin'`, and honor the existing `X-QD-Account` identity check. Return only safe admin account fields. Validate names like `sessionEndpoint`, normalize email with the existing `emailAddress()` helper, allow `null` to clear it, set `email_verified_at` for an administrator-approved replacement, and delete that account’s pending email challenges.

  For password changes, reuse the existing 9–128 check and `hashPassword`, perform a D1 batch that updates the hash and deletes all target `account_sessions`, and never include the password in a response or log. For role/status changes, use conditional updates and a count query in the same D1 batch/transaction pattern so `moon` protection and the “at least one admin” invariant hold under concurrent requests. Status disable must delete sessions; restore must only clear `disabled_at`.

  Add `/api/admin/` dispatch before ordinary room routes. Keep existing same-origin and failure handling. Make `getSession()`/WebSocket checks observe the disabled state so a revoked connection cannot continue.

- [ ] **Step 4: Run focused API tests and verify they pass**

  Run: `node --test tests/admin-worker.test.mjs`

  Expected: all admin authorization, role, password, email, session revocation, and concurrency assertions pass.

- [ ] **Step 5: Run existing auth/integration regressions**

  Run: `node --test tests/email-recovery-worker.test.mjs tests/registration-email.test.mjs tests/integration.test.mjs`

  Expected: existing registration, recovery, account isolation, and WebSocket tests pass with `role=user` defaults.

- [ ] **Step 6: Commit the API slice**

  ```powershell
  git add worker/admin.ts worker/index.ts worker/auth.ts worker/email-recovery.ts tests/admin-worker.test.mjs
  git commit -m "feat: add protected admin account API"
  ```

### Task 3: Add the `/admin` React page and route behavior

**Files:**
- Create: `src/AdminPage.jsx`
- Create: `src/admin.css`
- Modify: `src/App.jsx`
- Test: `tests/admin-ui.test.mjs`

**Interfaces:**
- Consumes `api()` and `session.user.role` from the existing `App` session state.
- Produces a page with `aria-label="账号管理后台"`, safe row actions, and callbacks for `onUnauthorized`/`onBack` so `App` can return to `/` after a 401/403.

- [ ] **Step 1: Write failing UI tests**

  Use the project’s existing JSDOM/React test harness pattern. Assert that an admin sees the “管理后台” entry, `/admin` loads the list and renders username/name/role/status without password fields, normal users do not see the entry, and direct non-admin access renders an access-denied state. Assert request bodies for name/email, password, role, and status actions; `moon` renders no destructive controls; successful password/status actions show the re-login notice.

- [ ] **Step 2: Run focused UI tests and verify they fail**

  Run: `node --test tests/admin-ui.test.mjs`

  Expected: FAIL because `AdminPage.jsx`, route handling, and admin styles do not exist.

- [ ] **Step 3: Implement the admin page and App routing**

  Add the route check before room rendering so `/admin` preserves its path through login and returns to the page after admin authentication. Add a profile-menu link only when `session.user.role === 'admin'`. Render a responsive table/card layout with search/filter, edit dialog, password dialog, role confirmation, and status confirmation. Do not retain password values in localStorage, URL, or persistent state after submit.

  On API 401/403, clear the admin page state and navigate to `/`; on normal account settings and home navigation, preserve existing behavior. Import `admin.css` without changing canvas styles.

- [ ] **Step 4: Run focused UI tests and verify they pass**

  Run: `node --test tests/admin-ui.test.mjs`

  Expected: all visibility, routing, safe-control, request, and failure-state assertions pass.

- [ ] **Step 5: Commit the frontend slice**

  ```powershell
  git add src/AdminPage.jsx src/admin.css src/App.jsx tests/admin-ui.test.mjs
  git commit -m "feat: add admin account management page"
  ```

### Task 4: Document deployment and run the full verification

**Files:**
- Modify: `docs/cloudflare-setup.md`
- Modify: `README.md`
- Test/verification: all project tests and build checks

**Interfaces:**
- Documents the exact migration order and the one-time SQL for a production database where `moon` did not exist when migration `0006` ran.

- [ ] **Step 1: Add the deployment and security notes**

  Document that `npm run db:local`/`npm run db:remote` applies `0006` before deployment; show a one-time `UPDATE accounts SET role='admin' WHERE username='moon'` only after verifying that the intended account exists; explain that passwords use per-password random salts and that admin resets invalidate all sessions. Do not put real credentials or production values in the repository.

- [ ] **Step 2: Run the complete test suite**

  Run: `npm test`

  Expected: all existing and new tests pass.

- [ ] **Step 3: Run typecheck and deploy dry-run**

  Run: `npm run check` and `npm run deploy:check`

  Expected: TypeScript emits no errors and Wrangler produces a dry-run bundle without deploying.

- [ ] **Step 4: Inspect the final diff for secrets and password leakage**

  Run: `git diff --check` and search changed files for `password_hash`, raw password logging, or test credentials accidentally added to UI/README. Confirm only encoded hashes appear in test fixtures and no plain password is included in API responses.

- [ ] **Step 5: Commit documentation and verification results**

  ```powershell
  git add README.md docs/cloudflare-setup.md
  git commit -m "docs: document admin account operations"
  ```

## Self-review

- Schema/role/status, protected `moon`, admin API, session invalidation, password salt reuse, frontend route/actions, deployment bootstrap, and verification each have an owning task.
- All interfaces in later tasks are produced by earlier tasks (`Session.role`, `requireAdmin`, `/api/admin/*`, and `AdminPage` callbacks).
- Review focus inputs are pinned to tests in tasks 2 and 3.
- The plan does not include production migration/deployment; that remains a manual user operation after review.
