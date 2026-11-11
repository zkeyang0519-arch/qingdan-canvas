import {
  Component,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import OpeningCover from "./OpeningCover.jsx";
import OpeningPreparation, {
  OpeningPreparationContext,
} from "./OpeningPreparation.jsx";
import "./opening.css";

class DestinationBoundary extends Component {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <OpeningPreparation
        id="render-error"
        status="error"
        error="页面暂时无法打开，请重试。"
        reloadOnRetry
      >
        <div className="loading-screen" role="alert">
          <p>页面暂时无法打开，请重试。</p>
          <button onClick={() => location.reload()}>重新加载</button>
        </div>
      </OpeningPreparation>
    ) : (
      this.props.children
    );
  }
}

function CoverExperience({ children }) {
  const [phase, setPhase] = useState("waiting");
  const [attempt, setAttempt] = useState(0);
  const [reports, setReports] = useState({});
  const [painted, setPainted] = useState(null);
  const [stalled, setStalled] = useState(false);
  const generation = useRef(0);
  const entered = useRef(false);
  const [reduced, setReduced] = useState(
    () =>
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || false,
  );
  const destination = useRef(null);
  const report = useCallback(
    (id, value) => {
      if (entered.current || attempt !== generation.current) return;
      setReports((previous) => {
        if (
          value
            ? previous[id]?.status === value.status &&
              previous[id]?.error === value.error &&
              previous[id]?.reloadOnRetry === value.reloadOnRetry
            : !previous[id]
        )
          return previous;
        const next = { ...previous };
        if (value) next[id] = value;
        else delete next[id];
        return next;
      });
    },
    [attempt],
  );
  const allReady =
    reports.page?.status === "ready" &&
    Object.values(reports).every((item) => item.status === "ready");
  const ready = allReady && painted === reports;
  const failure = Object.values(reports).find(
    (item) => item.status === "error",
  );
  const error =
    failure?.error ||
    (failure
      ? "准备未能完成，请重试。"
      : stalled && !allReady
        ? "准备时间有点久，请检查网络后重试。"
        : "");
  const status = error ? "error" : ready ? "ready" : "loading";
  const retry = () => {
    // React.lazy retains pending and rejected imports across remounts. Those
    // resources require a fresh page; ordinary network retries stay here.
    if (Object.values(reports).some((item) => item.reloadOnRetry)) {
      location.reload();
      return;
    }
    generation.current++;
    entered.current = false;
    setReports({});
    setPainted(null);
    setStalled(false);
    setPhase("waiting");
    setAttempt(generation.current);
  };

  useLayoutEffect(() => {
    if (!allReady || entered.current) return;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setPainted(reports));
    });
    return () => cancelAnimationFrame(frame);
  }, [allReady, reports]);

  useEffect(() => {
    if (phase === "entered" || allReady) return;
    const timer = setTimeout(() => setStalled(true), 20000);
    return () => clearTimeout(timer);
  }, [attempt, allReady, phase]);

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!media) return;
    const change = (event) => setReduced(event.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);

  useEffect(() => {
    if (phase !== "entering") return;
    if (!ready) {
      setPhase("waiting");
      return;
    }
    const finish = () => {
      entered.current = true;
      setPhase("entered");
    };
    if (reduced) {
      finish();
      return;
    }
    // The gate must also open when CSS animation events are unavailable.
    const timer = setTimeout(finish, 1250);
    return () => clearTimeout(timer);
  }, [phase, reduced, ready]);

  useLayoutEffect(() => {
    if (phase === "entered") return;
    // Inert protects descendants, but the canvas also listens on document.
    // Stop app shortcuts while preserving native browser shortcut defaults.
    const blockShortcuts = (event) => event.stopImmediatePropagation();
    const events = ["keydown", "keypress", "keyup", "paste", "cut", "copy"];
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
      <OpeningPreparationContext.Provider value={report}>
        <div
          ref={destination}
          className="opening-destination"
          inert={phase !== "entered"}
          aria-hidden={phase !== "entered" ? true : undefined}
          role="region"
          aria-label="轻单"
          tabIndex={-1}
        >
          <DestinationBoundary key={attempt}>{children}</DestinationBoundary>
        </div>
      </OpeningPreparationContext.Provider>
      {phase !== "entered" && (
        <OpeningCover
          entering={phase === "entering"}
          reducedMotion={reduced}
          status={status}
          error={error}
          onRetry={retry}
          onEnter={() => {
            if (phase !== "waiting" || !ready) return;
            if (reduced) entered.current = true;
            setPhase(reduced ? "entered" : "entering");
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
