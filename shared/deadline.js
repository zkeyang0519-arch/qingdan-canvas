// Stored instants are canonical UTC; local date/time conversion belongs to the UI.
export function validDeadline(value) {
  if (typeof value !== "string" || value.length !== 24) return false;
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
  );
}

const minute = 60000,
  hour = 60 * minute,
  day = 24 * hour;

export function deadlineInfo(block, now = Date.now()) {
  if (!validDeadline(block?.dueAt))
    return {
      status: "none",
      ratio: 0,
      compact: "",
      relative: "未设置截止时间",
    };
  if (block.done)
    return { status: "done", ratio: 1, compact: "完成", relative: "已完成" };
  const remaining = Date.parse(block.dueAt) - now;
  const late = remaining <= 0;
  const totalMinutes = Math.floor(Math.abs(remaining) / minute);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const duration = [
    days && `${days} 天`,
    hours && `${hours} 小时`,
    minutes && `${minutes} 分钟`,
  ]
    .filter(Boolean)
    .join(" ");
  return {
    status: late ? "late" : remaining <= day ? "urgent" : "normal",
    ratio: Math.max(0, Math.min(1, remaining / day)),
    compact: late
      ? "超时"
      : days
        ? `${days}天`
        : hours
          ? `${hours}h`
          : minutes
            ? `${minutes}m`
            : "<1m",
    relative: `${late ? "已超时" : "剩余"}${duration ? " " + duration : "不足 1 分钟"}`,
  };
}

export function deadlineInputValue(value) {
  if (!validDeadline(value)) return "";
  const date = new Date(value);
  const pad = (n) => String(n).padStart(2, "0");
  return `${String(date.getFullYear()).padStart(4, "0")}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function parseDeadlineInput(value) {
  const date = new Date(value);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ||
    !Number.isFinite(date.getTime())
  )
    throw Error("请选择有效的截止日期和时间。");
  const result = date.toISOString();
  // Reject rollover dates and local times skipped by daylight-saving changes.
  if (!validDeadline(result) || deadlineInputValue(result) !== value)
    throw Error("这个日期或时间不存在，请重新选择。");
  return result;
}

export function nextDeadlineTick(deadlines, now) {
  let delay = 30000;
  for (const due of deadlines)
    for (const boundary of [due - day, due])
      if (boundary > now) delay = Math.min(delay, boundary - now);
  return delay;
}
