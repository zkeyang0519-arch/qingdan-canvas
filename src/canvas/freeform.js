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
