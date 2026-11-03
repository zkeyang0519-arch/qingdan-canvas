import path from "node:path";

export async function startExperience({ root, run, isClosing, onReady }) {
  if (isClosing()) return;
  await run(path.join(root, "scripts/build-runner.mjs"));
  if (isClosing()) return;
  onReady();
  if (isClosing()) return;
  await run(path.join(root, "scripts/dev.mjs"));
}
