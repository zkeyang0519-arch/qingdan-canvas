import { deadlineInputValue } from "../../shared/deadline.js";

const pad = (value) => String(value).padStart(2, "0");

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

export function deadlineSelectionValue(parts) {
  return `${String(parts.year).padStart(4, "0")}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}
