import { ancestors, effectivelyLocked, selectionRoots } from "./layout.js";

// Only free, writable cards can become a new group. Recheck against the latest
// snapshot on click: another collaborator may have moved or locked a card.
export function groupableCards(state, boardId, selected) {
  const roots = selectionRoots(state.objects, selected);
  const cards = roots.map((key) => state.objects.find((o) => o.id === key));
  return cards.length >= 2 &&
    cards.every(
      (o) =>
        o &&
        o.boardId === boardId &&
        ["note", "image"].includes(o.type) &&
        !effectivelyLocked(state.objects, o.id) &&
        !ancestors(state.objects, o.id).some((p) =>
          ["frame", "collection"].includes(p.type),
        ),
    )
    ? cards
    : [];
}

// Presentation only. The stable ID keeps the angle identical across clients
// and reloads without adding rotation to the shared note geometry.
export function cardTilt(object) {
  if (
    object.type !== "image" &&
    (object.type !== "note" || object.noteKind === "checklist")
  )
    return 0;
  let hash = 0;
  for (const char of object.id) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return [-1.6, 1.4, -1, 1.8][Math.abs(hash) % 4];
}
