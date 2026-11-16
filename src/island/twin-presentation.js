import { validDeadline } from "../../shared/deadline.js";

// Presentation only: keep the workspace's task order and stored UTC deadlines.
export function twinTime(task, remaining, now = new Date()) {
  if (!task)
    return { kind: "empty", label: "", value: "已清空", title: "暂无待办" };
  if (!validDeadline(task.block.dueAt))
    return {
      kind: "count",
      label: "剩余",
      value: `${remaining} 项`,
      title: `还有 ${remaining} 项待办`,
    };
  const due = new Date(task.block.dueAt);
  const day = (date) =>
    `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const label =
    day(due) === day(now)
      ? "今天"
      : day(due) === day(tomorrow)
        ? "明天"
        : `${due.getMonth() + 1}/${due.getDate()}`;
  const value = `${String(due.getHours()).padStart(2, "0")}:${String(due.getMinutes()).padStart(2, "0")}`;
  return { kind: "deadline", label, value, title: `截止 ${day(due)} ${value}` };
}
