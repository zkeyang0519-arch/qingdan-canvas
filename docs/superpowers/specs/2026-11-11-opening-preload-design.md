# Opening cover preparation

The user approved preparing the destination behind the existing inspiration-wall cover, enabling entry only after its first screen is ready, and merging the current arranged branch into main.

## Behavior

- Mount the real application immediately behind the cover. Keep its layout measurable, but hide it and make it inert until entry; block application keyboard and clipboard shortcuts while the cover is present.
- During preparation, keep the existing design and show “正在准备你的空间…” with a small circular indicator. The central card cannot enter yet.
- Once ready and committed to the screen, show “打开我的空间”, restore the arrow with one subtle highlight, and wait for an explicit click or native keyboard activation. Never enter automatically.
- The existing exit animation reveals the already mounted destination. Do not remount or repeat startup requests on entry. Reduced motion still requires readiness and an explicit action.
- Logged-out readiness means the session check finished and login is rendered. Home readiness means the session and room list finished. A direct room/invitation requires the first server snapshot, not just cached local state. A lazy first-screen calendar must also finish loading.
- Failed preparation or a 20-second stall offers retry on the cover. Retry restarts preparation and ignores obsolete results; a later successful result can recover without forcing a retry. Invalid destinations can return to the home route. Noncritical cover images and ongoing synchronization after initial readiness do not block entry.
- Preserve invitation processing, account isolation, OAuth consent bypass, current cover styling, TODO branding, and existing data/protocols. No Agent changes or live user-data manipulation.

## Validation

Exercise delayed session/list/snapshot, cached drafts before snapshot, retry and stale requests, timeout, first-screen lazy content, keyboard/clipboard isolation, native keyboard activation, reduced motion, and OAuth bypass. Check desktop/mobile appearance in an isolated browser, then run the repository's test, type-check and deployment dry-run commands before review and merge.
