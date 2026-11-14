# Project chat progress and agent binding

**Goal:** Implement the user's specified running display, final-only completed display, and unified agent/project binding.

**Approach:** Keep each received subtask explanation above one current program line while running. Replace that line as new program output arrives. At terminal completion remove progress DOM and show the delivered final answer. Preserve explicit failure/recovery actions. Use the existing binding drawer to select an agent/device and Codex project together. Preserve all existing unrelated workspace edits.

- [x] Replace progress disclosures in `ExecutionOutput.jsx`; regression tests cover in-place process updates, next-subtask ordering, completion, cancellation, historical reads, and missing/delayed final answers.
- [x] Carry explicit assistant message phase and final output through Runner events/reports and the Worker run view; verify continued turns and delayed result delivery.
- [x] Consolidate agent/device operations into `ProjectBindingPicker.jsx` and rename the workspace entry to `绑定 agent`; verify initial setup and rebinding.
- [x] Check actual components in an isolated browser fixture at desktop/mobile widths. Run `npm test`, `npm run check`, `npm run runner:check`, and `npm run deploy:check`. No deployment or changes to the user's device binding.

Verified: final full suite 1413/1413; desktop 1440px and mobile 390px browser interaction checks; both TypeScript checks; build and deployment dry run. Restarted the installed local Agent through its supported lifecycle command after confirming zero active/unknown runs. It rebuilt the final frontend/Runner and returned ready/running with zero retries. Evidence: `output/agent-live-result-2026-11-13/`.
