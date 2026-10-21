import { screenToWorld } from "./geometry.js";

export const COLLECTION_DOCK = { x: 20, y: 20, width: 40, height: 40 };

// One fixed entrance per board; additional boxes remain ordinary canvas objects.
export const primaryCollection = (state, boardId) => {
  const candidates =
    state?.objects.filter(
      (o) => o.boardId === boardId && o.type === "collection" && !o.parentId,
    ) || [];
  const preferred = state?.boards?.find(
    (b) => b.id === boardId,
  )?.primaryCollectionId;
  return candidates.find((o) => o.id === preferred) || candidates[0];
};

// Retain each board's entrance when older boxes are released or moved in.
// Old workspaces acquire this optional ID without moving any stored objects.
export function retainCollectionDocks(state) {
  if (!state?.boards) return state;
  const boards = state.boards.map((board) => {
    const dock = primaryCollection(state, board.id);
    if (board.primaryCollectionId === dock?.id) return board;
    if (dock) return { ...board, primaryCollectionId: dock.id };
    const { primaryCollectionId, ...rest } = board;
    return rest;
  });
  return boards.some((board, i) => board !== state.boards[i])
    ? { ...state, boards }
    : state;
}

export const collectionDockWorldRect = (view) => ({
  ...screenToWorld(COLLECTION_DOCK, view),
  width: COLLECTION_DOCK.width / view.scale,
  height: COLLECTION_DOCK.height / view.scale,
});

export const collectionTakeOutPoint = (collection, dockId, view) =>
  collection.id === dockId
    ? screenToWorld(
        {
          x: COLLECTION_DOCK.x + COLLECTION_DOCK.width + 32,
          y: COLLECTION_DOCK.y,
        },
        view,
      )
    : { x: collection.x + collection.width + 32, y: collection.y };
