import { deadlineInputValue } from "../../shared/deadline.js";

const pad = (value) => String(value).padStart(2, "0");
const numbers = (start, count) =>
  Array.from({ length: count }, (_, index) => start + index);

export function deadlineSelection(value, now = Date.now()) {
  const input =
    deadlineInputValue(value) ||
    `${deadlineInputValue(new Date(now).toISOString()).slice(0, 10)}T23:59`;
  const [year, month, day, hour, minute] = input.split(/\D/).map(Number);
  return { year, month, day, hour, minute };
}

export function deadlineMonthDays({ year, month }) {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][
    month - 1
  ];
}

export function updateDeadlineSelection(parts, field, value) {
  const next = { ...parts, [field]: Number(value) };
  next.day = Math.min(next.day, deadlineMonthDays(next));
  return next;
}

export function deadlineWheelFields() {
  return [
    {
      key: "hour",
      label: "时",
      name: "截止小时",
      options: numbers(0, 24),
      format: (value) => String(value).padStart(2, "0"),
      loop: true,
    },
    {
      key: "minute",
      label: "分",
      name: "截止分钟",
      options: numbers(0, 60),
      format: (value) => String(value).padStart(2, "0"),
      loop: true,
    },
  ];
}

export function deadlineCalendarDate({ year, month, day }) {
  const date = new Date(0);
  date.setHours(12, 0, 0, 0);
  date.setFullYear(year, month - 1, day);
  return date;
}

export function selectDeadlineDate(parts, date) {
  return {
    ...parts,
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
  };
}

export function deadlinePopoverSide(anchor, panel, viewport) {
  const gap = 20; // 8px anchor gap + 12px viewport padding.
  if (
    Math.max(anchor.top, viewport.height - anchor.bottom) - gap >=
    panel.height
  )
    return "bottom"; // Radix flips upward when that side has more room.
  if (viewport.width - anchor.right - gap >= panel.width) return "right";
  if (anchor.left - gap >= panel.width) return "left";
  return "bottom";
}

export function deadlineSelectionValue(parts) {
  return `${String(parts.year).padStart(4, "0")}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}
