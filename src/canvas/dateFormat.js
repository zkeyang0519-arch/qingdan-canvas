const creationFormat = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function validCreatedAt(value) {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value))
  );
}

export function formatCreatedAt(value) {
  return validCreatedAt(value) ? creationFormat.format(new Date(value)) : "";
}
