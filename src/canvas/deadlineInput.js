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

export function deadlineWheelFields(
  parts,
  currentYear = new Date().getFullYear(),
) {
  const monthDays = deadlineMonthDays(parts);
  const years = [...new Set([...numbers(currentYear - 5, 16), parts.year])]
    .filter((year) => year >= 1 && year <= 9999)
    .sort((a, b) => a - b);
  return [
    { key: "year", label: "年", name: "截止年份", options: years },
    {
      key: "month",
      label: "月",
      name: "截止月份",
      options: numbers(1, 12),
      loop: true,
    },
    {
      key: "day",
      label: "日",
      name: "截止日期",
      options: numbers(1, 31),
      stepOptions: numbers(1, monthDays),
      isOptionEnabled: (value) => value <= monthDays,
      normalizeValue: (value) => Math.min(value, monthDays),
      loop: true,
    },
    {
      key: "hour",
      label: "时",
      name: "截止小时",
      options: numbers(0, 24),
      loop: true,
    },
    {
      key: "minute",
      label: "分",
      name: "截止分钟",
      options: [...numbers(1, 59), 0],
      format: (value) => String(value || 60).padStart(2, "0"),
      loop: true,
    },
  ];
}

export function wheelStepValue(options, value, delta, loop = false) {
  if (!options.length) return value;
  const current = options.indexOf(Number(value));
  const index = current === -1 ? 0 : current;
  const step = Math.sign(delta);
  if (!step) return options[index];
  if (loop) return options[(index + step + options.length) % options.length];
  const next = Math.min(options.length - 1, Math.max(0, index + step));
  return options[next];
}

export function wheelDeltaSteps(delta, remainder = 0, threshold = 120) {
  if (!Number.isFinite(delta) || !Number.isFinite(remainder) || threshold <= 0)
    return { steps: 0, remainder };
  const total = remainder + delta;
  const steps =
    total >= 0 ? Math.floor(total / threshold) : Math.ceil(total / threshold);
  return { steps, remainder: total - steps * threshold };
}

export function deadlineSelectionValue(parts) {
  return `${String(parts.year).padStart(4, "0")}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}
