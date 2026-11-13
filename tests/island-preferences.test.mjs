import test from "node:test";
import assert from "node:assert/strict";
import { createWorkspace } from "../src/canvas/model.js";
import {
  getIslandPreferences,
  setIslandPreferences,
} from "../src/island/preferences.js";

test("island preference does not change shared content, surface or another room", () => {
  const state = createWorkspace();
  const boardId = state.boards[0].id;
  state.preferences.views[boardId] = {
    surface: "agent",
    x: 15,
    arranged: { pageId: "project" },
  };
  state.preferences.views.other = { surface: "arranged" };
  const next = setIslandPreferences(state, boardId, {
    enabled: true,
    pinned: true,
  });
  assert.deepEqual(getIslandPreferences(next, boardId), {
    enabled: true,
    pinned: true,
  });
  assert.equal(next.objects, state.objects);
  assert.equal(next.boards, state.boards);
  assert.equal(next.preferences.views.other, state.preferences.views.other);
  assert.equal(next.preferences.views[boardId].surface, "agent");
  assert.deepEqual(next.preferences.views[boardId].arranged, {
    pageId: "project",
  });
  assert.deepEqual(getIslandPreferences(state, boardId), {
    enabled: false,
    pinned: false,
  });
});

test("malformed saved settings cannot enable an island and unchanged writes are noops", () => {
  const state = createWorkspace();
  const boardId = state.boards[0].id;
  state.preferences.views[boardId] = {
    dynamicIsland: { enabled: "true", pinned: 1 },
  };
  assert.deepEqual(getIslandPreferences(state, boardId), {
    enabled: false,
    pinned: false,
  });
  assert.equal(
    setIslandPreferences(state, "missing", { enabled: true }),
    state,
  );
  const next = setIslandPreferences(state, boardId, { enabled: true });
  assert.equal(setIslandPreferences(next, boardId, { enabled: true }), next);
  assert.deepEqual(
    getIslandPreferences(
      setIslandPreferences(next, boardId, { enabled: false }),
      boardId,
    ),
    { enabled: false, pinned: false },
  );
});
