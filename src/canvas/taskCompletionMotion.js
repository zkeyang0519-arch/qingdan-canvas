export function createCompletionMotion({
  eventId,
  fromRect,
  toRect,
  text,
  reducedMotion,
  visible,
}) {
  if (
    !visible ||
    reducedMotion ||
    !fromRect ||
    !toRect ||
    fromRect.width <= 0 ||
    toRect.width <= 0 ||
    fromRect.height <= 0 ||
    toRect.height <= 0
  )
    return null;
  let startsAt = 0;
  const stages = [
    ["lift", 150],
    ["confirm", 200],
    ["travel", 400],
    ["settle", 150],
  ].map(([name, duration]) => {
    const stage = { name, duration, startsAt };
    startsAt += duration;
    return stage;
  });
  return {
    eventId,
    fromRect,
    toRect,
    text,
    stages,
    duration: startsAt,
    lift: 10,
  };
}
const clamp = (value) => Math.max(0, Math.min(1, value));
// Zero velocity and acceleration at both ends keep the hold, flight and landing joined.
const ease = (value) => {
  const t = clamp(value);
  return t * t * t * (t * (t * 6 - 15) + 10);
};
const mix = (a, b, t) => a + (b - a) * t;

export function completionPoseAt(motion, milliseconds, target = motion.toRect) {
  const { fromRect: from, lift } = motion;
  const raised = ease(milliseconds / 150),
    travel = ease((milliseconds - 350) / 400);
  const scale = 1 + 0.03 * raised;
  const startX = (-(scale - 1) * from.width) / 2;
  const startY = -lift * raised - ((scale - 1) * from.height) / 2;
  const landing = clamp((milliseconds - 750) / 150);
  const arc = Math.min(24, from.width * 0.08) * 4 * travel * (1 - travel);
  const bounce =
    8 *
    Math.sin(2 * Math.PI * landing) *
    Math.sin(Math.PI * landing) ** 2 *
    (1 - landing);
  return {
    x: mix(startX, target.x - from.x, travel) + arc,
    y: mix(startY, target.y - from.y, travel) + bounce,
    scaleX: mix(scale, target.width / from.width, travel),
    scaleY: mix(scale, target.height / from.height, travel),
  };
}

export function completionFlightFrames(motion) {
  // Interpolate finely sampled poses on the compositor; JS only adjusts a moving destination.
  return Array.from({ length: motion.duration / 10 + 1 }, (_, index) => {
    const time = index * 10,
      pose = completionPoseAt(motion, time);
    return {
      offset: time / motion.duration,
      transform: `translate3d(${pose.x}px,${pose.y}px,0) scale(${pose.scaleX},${pose.scaleY})`,
    };
  });
}

export function rectIsVisible(rect, container, viewport = window) {
  return (
    rect?.width > 0 &&
    rect.height > 0 &&
    rect.left >= Math.max(0, container?.left || 0) - 1 &&
    rect.right <=
      Math.min(viewport.innerWidth, container?.right ?? Infinity) + 1 &&
    rect.top >= Math.max(0, container?.top || 0) - 1 &&
    rect.bottom <=
      Math.min(viewport.innerHeight, container?.bottom ?? Infinity) + 1
  );
}

export function completionDestination(target, panel, manual) {
  const measured = target.getBoundingClientRect(),
    panelRect = panel.getBoundingClientRect();
  if (!manual) return { toRect: measured, scrollDelta: 0 };
  let missingHeight = 0,
    finalTop = measured.top;
  const arrivals = [];
  for (const slot of panel.children) {
    const row = slot.querySelector(".todo-row");
    if (!row) continue;
    const rect = row.getBoundingClientRect(),
      top = rect.top + missingHeight;
    if (row === target) finalTop = top;
    if (row === target || row.dataset.completionHidden === "true")
      arrivals.push({ top, bottom: top + rect.height });
    if (slot.classList.contains("completion-target-slot"))
      missingHeight += Math.max(
        0,
        rect.height - slot.getBoundingClientRect().height,
      );
  }
  // Include the final height of earlier arrivals, even while their slots are collapsed.
  let top = Math.min(...arrivals.map((r) => r.top)),
    bottom = Math.max(...arrivals.map((r) => r.bottom));
  if (bottom - top > panelRect.height - 6) {
    top = finalTop;
    bottom = top + measured.height;
  }
  const scrollDelta = Math.max(
    -panel.scrollTop,
    top < panelRect.top
      ? top - panelRect.top
      : Math.max(0, bottom - panelRect.bottom + 6),
  );
  const y = finalTop - scrollDelta;
  return {
    scrollDelta,
    toRect: {
      x: measured.x,
      y,
      left: measured.left,
      right: measured.right,
      top: y,
      bottom: y + measured.height,
      width: measured.width,
      height: measured.height,
    },
  };
}

// Freeze the actual row (including rich text and remark tools), not a text-only approximation.
export function captureCompletionSource(element) {
  if (
    !element?.animate ||
    document.hidden ||
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  )
    return null;
  const fromRect = element.getBoundingClientRect();
  if (
    !rectIsVisible(
      fromRect,
      element.closest(".todo-panel-body")?.getBoundingClientRect(),
    )
  )
    return null;
  const card = element.cloneNode(true),
    originals = [element, ...element.querySelectorAll("*")];
  [card, ...card.querySelectorAll("*")].forEach((node, index) => {
    const style = window.getComputedStyle(originals[index]);
    node.style.cssText = Array.from(
      style,
      (name) => `${name}:${style.getPropertyValue(name)};`,
    ).join("");
    // Chromium resolves this to a literal color; freezing it would mask animated `color`.
    node.style.setProperty("-webkit-text-fill-color", "currentColor");
    node.style.animation = "none";
    node.style.transition = "none";
    for (const name of [
      "id",
      "data-task-id",
      "data-object-id",
      "aria-label",
      "role",
      "contenteditable",
    ])
      node.removeAttribute(name);
    node.removeAttribute("tabindex");
  });
  Object.assign(card.style, {
    width: "100%",
    height: "100%",
    margin: "0",
    transform: "none",
    background: "transparent",
    boxShadow: "none",
    borderRadius: "8px",
  });
  const text = element.querySelector(".todo-copy"),
    bounds = text?.getBoundingClientRect(),
    lines = [];
  if (bounds) {
    const walker = document.createTreeWalker(text, 4);
    while (walker.nextNode()) {
      const range = document.createRange();
      range.selectNodeContents(walker.currentNode);
      for (const r of range.getClientRects?.() || []) {
        const left = Math.max(r.left, bounds.left),
          right = Math.min(r.right, bounds.right);
        if (right <= left) continue;
        const y = r.top + r.height * 0.52 - fromRect.top;
        const line = lines.find((l) => Math.abs(l.y - y) < 3);
        if (line) {
          line.right = Math.max(line.right, right - fromRect.left);
          line.x = Math.min(line.x, left - fromRect.left);
        } else
          lines.push({
            x: left - fromRect.left,
            right: right - fromRect.left,
            y,
          });
      }
    }
    if (!lines.length)
      lines.push({
        x: bounds.left - fromRect.left,
        right: bounds.right - fromRect.left,
        y: bounds.top + bounds.height / 2 - fromRect.top,
      });
  }
  return {
    fromRect,
    card,
    lines,
    backgroundColor: window.getComputedStyle(element).backgroundColor,
  };
}
export function observeCompletionMotion({
  window,
  document,
  media,
  duration,
  onFinished,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let done = false,
    timer;
  const cleanup = () => {
    clearTimer(timer);
    window?.removeEventListener("resize", finish);
    document?.removeEventListener("visibilitychange", finish);
    media?.removeEventListener("change", finish);
  };
  const finish = () => {
    if (done) return;
    done = true;
    cleanup();
    onFinished();
  };
  window?.addEventListener("resize", finish);
  document?.addEventListener("visibilitychange", finish);
  media?.addEventListener("change", finish);
  timer = setTimer(finish, duration + 80);
  return {
    finish,
    dispose() {
      done = true;
      cleanup();
    },
  };
}
