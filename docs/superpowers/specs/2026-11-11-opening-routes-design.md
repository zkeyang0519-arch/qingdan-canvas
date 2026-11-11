# Opening page and workspace routes

The user approved separating the cover from application pages, implementing it in the current arranged branch and merging main.

## Intent and approach

The cover currently wraps every ordinary page, so a refresh inside a room requires another entry click. Use explicit page addresses: `/` is the opening page, `/app` is login or the workspace list, and `/app?room=…` is the selected room. A browser-session “seen cover” flag was considered; route separation is selected because refresh/bookmarks and deliberately revisiting the opening page have clear behavior.

## Behavior

- Only visiting `/` without a room target shows the cover. It keeps background preparation, explicit activation, reduced motion, retries and the existing transition.
- Completing entry adds `/app` to history and reveals the same prepared App instance, without repeating startup requests.
- Direct application visits and refreshes show the application immediately, including its ordinary loading/error feedback; they never require the cover. Room preferences continue restoring canvas/arranged mode from the existing draft store.
- Legacy `/?room=…` links normalize to `/app?room=…` with query parameters and invitation hash preserved. New invitations use `/app`. Authentication and invitation processing remain intact.
- Internal home/return-list/logout links stay under `/app`. Room selection, creation, joining and returning to the list create appropriate history entries; bootstrap/invitation normalization replaces the current entry. History back/forward restores the destination from its URL; returning deliberately to `/` restores the cover.
- Keep the prepared App mounted during cover entry. On browser history restoration, remount the destination to reuse its established session, room and draft bootstrap/cleanup, so outdated requests cannot mutate the new route.
- Guard delayed mutation failures against obsolete sessions. If a successful login/registration/logout response changes cookies after its original page unmounts, revalidate the current destination in place without reviving the old URL or entering the cover automatically.
- Dedicated `/mcp/consent` authorization remains outside the cover; its return-to-app links target `/app`.

## Constraints and validation

Use the existing React/History API and the existing isolated feature worktree. No new routing dependency, Agent/server/schema changes, or live-record edits. Validate URL and component lifecycle regressions, new/old invitations, stale requests after history navigation, direct home/room refresh, mode restoration, native back/forward, and no duplicate fetch or loader after entry. Run tests, type checking and deployment dry run before review/merge and verify the automatic main build.
