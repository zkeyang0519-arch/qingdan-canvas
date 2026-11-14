# Online Qingdao

The user explicitly requests one click on the published canvas to open the desktop capsule with the current account and canvas, without another page, login, or canvas picker.

- Keep existing local launch, docking, synchronization, save receipts and draft protections.
- The local companion must already be installed/running. Browser loopback permission may be requested by the browser; explain denial in the existing launch notice.
- The browser first obtains a short-lived local challenge. Its authenticated online session authorizes a one-use grant for the selected room. Only the native companion has the verifier needed to redeem that grant.
- The grant creates a dedicated desktop session for the same account, bounded by the source session's remaining lifetime. Source-session expiry/logout and room access are checked at redemption; after redemption it is a separate device session, subject to existing password-change/session-revocation behavior.
- Never expose a login cookie to webpage JavaScript, URLs, command lines, logs, or ordinary files. Grant identifiers are short-lived and one-use; the verifier stays in local memory.
- Allow the exact production origins https://todo.zky.lol and https://qingdan-canvas.zkeyang0519.workers.dev by default. Extra HTTPS origins require explicit local configuration. No general cross-origin proxy or arbitrary command/profile/URL input.
- Reuse a ready capsule only when origin, account and room all match. Cross-origin switches preserve the previous renderer until its save succeeds, then load the new origin; failures restore the previous origin/window and the target origin's previous cookie.
- Only acknowledge success after the renderer has loaded the authorized room and is ready to operate. Account/room changes and aborted launches must invalidate pending activation.
- Agent remains disabled in production. The new desktop routes are independent of Agent routes.
- Work on the existing Agent branch in D:/TODO/qingdan-canvas, preserving the preceding local-entry-navigation fix. Do not deploy production or change real device bindings. Use isolated service/profile/account fixtures for acceptance.
