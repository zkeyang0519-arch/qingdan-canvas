import { useEffect, useRef, useState } from "react";
import OpeningCover from "./OpeningCover.jsx";
import "./opening.css";

function CoverExperience({ children }) {
  const [phase, setPhase] = useState("waiting");
  const [reduced, setReduced] = useState(
    () =>
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || false,
  );
  const destination = useRef(null);

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!media) return;
    const change = (event) => setReduced(event.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);

  useEffect(() => {
    if (phase !== "entering") return;
    if (reduced) {
      setPhase("entered");
      return;
    }
    // The gate must also open when CSS animation events are unavailable.
    const timer = setTimeout(() => setPhase("entered"), 1250);
    return () => clearTimeout(timer);
  }, [phase, reduced]);

  useEffect(() => {
    if (phase !== "entering") return;
    // Inert protects descendants, but the canvas also listens on document.
    // Stop app shortcuts while preserving native browser shortcut defaults.
    const blockShortcuts = (event) => event.stopImmediatePropagation();
    const events = ["keydown", "keypress", "keyup"];
    events.forEach((type) =>
      window.addEventListener(type, blockShortcuts, true),
    );
    return () =>
      events.forEach((type) =>
        window.removeEventListener(type, blockShortcuts, true),
      );
  }, [phase]);

  useEffect(() => {
    if (phase !== "entered") return;
    const content = destination.current;
    const target = content?.querySelector(
      "input:not([disabled]), button:not([disabled]), a[href]",
    );
    (target || content)?.focus({ preventScroll: true });
  }, [phase]);

  return (
    <div className="opening-gate" data-phase={phase}>
      {phase !== "waiting" && (
        <div
          ref={destination}
          className="opening-destination"
          inert={phase === "entering"}
          aria-hidden={phase === "entering" ? true : undefined}
          role="region"
          aria-label="轻单"
          tabIndex={-1}
        >
          {children}
        </div>
      )}
      {phase !== "entered" && (
        <OpeningCover
          entering={phase === "entering"}
          reducedMotion={reduced}
          onEnter={() => {
            if (phase === "waiting") setPhase(reduced ? "entered" : "entering");
          }}
        />
      )}
    </div>
  );
}

export default function OpeningGate({ children }) {
  // An OAuth client has already initiated this dedicated authorization flow.
  // Keep its original login/consent path free of the decorative entrance gate.
  return window.location.pathname === "/mcp/consent" ? (
    children
  ) : (
    <CoverExperience>{children}</CoverExperience>
  );
}
