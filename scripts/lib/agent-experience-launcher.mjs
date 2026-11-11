import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function startExperience({
  root,
  run,
  isClosing,
  onReady,
  supervisor,
}) {
  if (isClosing()) return;
  await run(path.join(root, "scripts/build-runner.mjs"));
  if (isClosing()) return;
  await onReady();
  if (isClosing()) return;
  if (supervisor) await supervisor.start();
  else await run(path.join(root, "scripts/dev.mjs"));
}

// One controller outlives every web-child attempt. This supervisor never stops,
// recreates or reconciles a Runner, and never replays an execution command.
export function createWebSupervisor({
  run,
  onState = () => {},
  sleep = (ms, signal) => delay(ms, undefined, { signal }),
}) {
  let state = { phase: "idle", retries: 0 },
    started = false,
    closed = false,
    driving = false;
  let finish;
  const done = new Promise((resolve) => {
    finish = resolve;
  });
  const abort = new AbortController();
  const publish = (phase, retries = state.retries) => {
    state = { phase, retries };
    onState({ ...state });
  };
  async function drive() {
    if (driving || closed) return;
    driving = true;
    try {
      for (let attempt = 0; !closed; attempt++) {
        publish("running", attempt);
        try {
          await run();
        } catch {
          /* A failed child is recoverable; its log retains the cause. */
        }
        if (closed) break;
        if (attempt === 3) {
          publish("recovery_required", attempt);
          break;
        }
        publish("backoff", attempt + 1);
        try {
          await sleep(1000 * 2 ** attempt, abort.signal);
        } catch {
          if (!closed) publish("recovery_required", attempt + 1);
          break;
        }
      }
    } finally {
      driving = false;
    }
  }
  return {
    start() {
      if (!started && !closed) {
        started = true;
        void drive();
      }
      return done;
    },
    status: () => ({ ...state }),
    recover() {
      if (!started || closed)
        throw Error("Web launcher is initializing or closing.");
      if (state.phase !== "recovery_required" || driving)
        return { accepted: false, web: { ...state } };
      void drive();
      return { accepted: true, web: { ...state } };
    },
    close() {
      if (closed) return done;
      closed = true;
      abort.abort();
      publish("stopped");
      finish();
      return done;
    },
  };
}
