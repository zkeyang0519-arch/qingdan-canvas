import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check } from "lucide-react";

export default function ContextMenu({
  anchor,
  items,
  onClose,
  label = "操作菜单",
}) {
  const ref = useRef(null),
    previous = useRef(document.activeElement),
    [position, setPosition] = useState(anchor);
  useLayoutEffect(() => {
    const r = ref.current.getBoundingClientRect();
    setPosition({
      x: Math.max(8, Math.min(anchor.x, innerWidth - r.width - 8)),
      y: Math.max(8, Math.min(anchor.y, innerHeight - r.height - 8)),
    });
    ref.current.querySelector("button:not(:disabled)")?.focus();
  }, [anchor.x, anchor.y]);
  useEffect(() => {
    const outside = (e) => {
      if (!ref.current?.contains(e.target)) onClose();
    };
    const key = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
        e.preventDefault();
        const buttons = [
          ...ref.current.querySelectorAll("button:not(:disabled)"),
        ];
        let i = buttons.indexOf(document.activeElement);
        i =
          e.key === "Home"
            ? 0
            : e.key === "End"
              ? buttons.length - 1
              : (i + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) %
                buttons.length;
        buttons[i]?.focus();
      }
      if (e.key === "Tab") onClose();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", key, true);
      if (previous.current?.isConnected)
        previous.current.focus?.({ preventScroll: true });
    };
  }, [onClose]);
  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      aria-label={label}
      style={{ left: position.x, top: position.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) =>
        item.separator ? (
          <div className="menu-separator" key={i} />
        ) : (
          <button
            key={item.label}
            role={item.checked !== undefined ? "menuitemcheckbox" : "menuitem"}
            aria-checked={item.checked}
            disabled={item.disabled}
            className={item.danger ? "danger" : ""}
            onClick={() => {
              onClose();
              item.action();
            }}
          >
            <span className="menu-icon">
              {item.checked ? <Check size={15} /> : item.icon}
            </span>
            <span>{item.label}</span>
            {item.shortcut && <kbd>{item.shortcut}</kbd>}
          </button>
        ),
      )}
    </div>
  );
}
