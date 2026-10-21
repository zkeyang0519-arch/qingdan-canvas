// Animate an inert visual copy outside scrolling panels, so the path begins at the basket.
export function animateReturnCopy(
  node,
  origin,
  host,
  layer,
  onDone = () => {},
) {
  if (
    !node.animate ||
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  )
    return null;
  const r = node.getBoundingClientRect(),
    h = host.getBoundingClientRect();
  const copy = node.cloneNode(true);
  for (const n of [copy, ...copy.querySelectorAll("*")]) {
    n.removeAttribute("data-object-id");
    n.removeAttribute("data-task-id");
    n.removeAttribute("id");
  }
  copy.classList.add("todo-returning");
  copy.setAttribute("aria-hidden", "true");
  copy.inert = true;
  Object.assign(copy.style, {
    left: `${r.x - h.x}px`,
    top: `${r.y - h.y}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
    transformOrigin: "0 0",
  });
  layer.appendChild(copy);
  const visible = node.style.visibility;
  node.style.visibility = "hidden";
  let done = false,
    timer;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    copy.remove();
    node.style.visibility = visible;
    onDone();
  };
  const a = copy.animate(
    [
      {
        transform: `translate(${origin.x + origin.width / 2 - (r.x - h.x) - r.width * 0.03}px,${origin.y + origin.height / 2 - (r.y - h.y) - r.height * 0.03}px) scale(.06)`,
        opacity: 0.2,
      },
      { transform: "translate(0,0) scale(1)", opacity: 1 },
    ],
    { duration: 420, easing: "cubic-bezier(.2,.75,.2,1)" },
  );
  a.onfinish = finish;
  a.oncancel = finish;
  timer = setTimeout(finish, 450);
  return {
    cancel() {
      a.cancel();
      finish();
    },
  };
}
