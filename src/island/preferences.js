export function getIslandPreferences(state, boardId) {
  const saved = state.preferences?.views?.[boardId]?.dynamicIsland;
  return { enabled: saved?.enabled === true, pinned: saved?.pinned === true };
}

export function setIslandPreferences(state, boardId, patch) {
  if (!state.boards.some((board) => board.id === boardId)) return state;
  const previous = getIslandPreferences(state, boardId);
  const next = {
    enabled:
      typeof patch.enabled === "boolean" ? patch.enabled : previous.enabled,
    pinned: typeof patch.pinned === "boolean" ? patch.pinned : previous.pinned,
  };
  if (!next.enabled) next.pinned = false;
  if (next.enabled === previous.enabled && next.pinned === previous.pinned)
    return state;
  return {
    ...state,
    preferences: {
      ...state.preferences,
      views: {
        ...state.preferences.views,
        [boardId]: { ...state.preferences.views[boardId], dynamicIsland: next },
      },
    },
  };
}
