import { createObject } from "../src/canvas/model.js";
import { normalizeLayout } from "../src/canvas/layout.js";
// Explicit old-format fixture for migration/geometry regression coverage.
// The current grouping command deliberately cannot create these hierarchies.
export function wrapLegacyGroup(state, ids) {
  const first = state.objects.find((o) => ids.includes(o.id));
  const frame = createObject(first.boardId, "frame");
  return normalizeLayout({
    ...state,
    objects: [
      ...state.objects.map((o) =>
        ids.includes(o.id) ? { ...o, parentId: frame.id } : o,
      ),
      frame,
    ],
  });
}
