import React, { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

export default function WorkspaceDrawer({ title, onClose, children }) {
  const panel = useRef(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    if (!document.querySelector(".agent-request-dialog"))
      panel.current?.focus();
    const key = (event) => {
      // Native approvals render above drawers and own the keyboard until closed.
      if (document.querySelector(".agent-request-dialog")) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        close.current?.();
      }
      if (event.key !== "Tab") return;
      const items = [
        ...panel.current.querySelectorAll(
          "button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],summary",
        ),
      ].filter((item) => {
        const collapsed = item.closest("details:not([open])");
        return !collapsed || collapsed.querySelector("summary") === item;
      });
      const first = items[0],
        last = items.at(-1);
      if (
        !items.includes(document.activeElement) ||
        (!event.shiftKey && document.activeElement === last)
      ) {
        event.preventDefault();
        first?.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      }
      event.stopImmediatePropagation();
    };
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("keydown", key, true);
      if (
        previous?.isConnected &&
        !document.querySelector(".agent-request-dialog")
      )
        previous.focus?.();
    };
  }, []);
  return createPortal(
    <div className="agent-workspace-drawer-backdrop">
      <section
        className="agent-workspace-drawer agent-trial"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={panel}
      >
        <header>
          <h2>{title}</h2>
          <button
            className="agent-icon-button"
            aria-label={`关闭${title}`}
            onClick={onClose}
          >
            <X size={19} />
          </button>
        </header>
        <div className="agent-workspace-drawer-body">{children}</div>
      </section>
    </div>,
    document.body,
  );
}
