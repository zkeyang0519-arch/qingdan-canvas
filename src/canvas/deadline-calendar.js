import { validDeadline, deadlineInfo } from "../../shared/deadline.js";
import { blockText } from "./model.js";

export function localDayKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function deadlineEvents(
  page,
  { showCompleted = false, now = Date.now() } = {},
) {
  return (page?.tasks || [])
    .filter(
      ({ block }) =>
        validDeadline(block.dueAt) && (showCompleted || !block.done),
    )
    .map(({ note, block, key }) => ({
      id: JSON.stringify([note.id, key]),
      title: blockText(block) || "空白待办",
      start: block.dueAt,
      allDay: false,
      extendedProps: {
        noteId: note.id,
        blockId: key,
        done: block.done ? 1 : 0,
        status: deadlineInfo(block, now).status,
      },
    }))
    .sort(
      (a, b) =>
        a.extendedProps.done - b.extendedProps.done ||
        a.start.localeCompare(b.start) ||
        a.id.localeCompare(b.id),
    );
}
