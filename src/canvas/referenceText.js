// Match the visible one-level reference label in notes and confirmed Agent context.
export function referenceLabel(run, objects) {
  const target = objects.get(run.targetId);
  if (!target) return run.label;
  return (
    (target.blocks?.[0]?.runs || [])
      .map((r) => (r.type === "text" ? r.text : `[[${r.label}]]`))
      .join("")
      .slice(0, 26) || run.label
  );
}
