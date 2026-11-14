import { useEffect, useRef, useState } from "react";

// RunCat RunnerGallery / Takuto Nakamura (Kyome22), Apache-2.0.
// The original silhouettes are bundled locally; see public/animals/runcat/NOTICE.md.
export const animalRunners = [
  { id: "classic-cat", name: "小猫", width: 63, frames: 5 },
  { id: "rabbit", name: "小兔", width: 43, frames: 5 },
  { id: "welsh-corgi", name: "柯基", width: 61, frames: 7 },
  { id: "shiba-inu", name: "柴犬", width: 58, frames: 8 },
  { id: "fox", name: "狐狸", width: 65, frames: 8 },
  { id: "chicken", name: "小鸡", width: 37, frames: 5 },
];
export const animalSwitchMs = 10_000;

export function createAnimalCycle(random = Math.random) {
  let remaining = [],
    previous;
  return () => {
    if (!remaining.length) {
      remaining = animalRunners.slice();
      for (let i = remaining.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
      }
      if (remaining[0].id === previous)
        [remaining[0], remaining[1]] = [remaining[1], remaining[0]];
    }
    const runner = remaining.shift();
    previous = runner.id;
    return runner;
  };
}

export function useAnimalRunner(active, surface) {
  const cycle = useRef(null);
  if (!cycle.current) cycle.current = createAnimalCycle();
  const [runner, setRunner] = useState(() => cycle.current());
  const [visible, setVisible] = useState(() => !document.hidden);
  const [inView, setInView] = useState(true);
  const [reduced, setReduced] = useState(
    () =>
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
  );
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const visibility = () => setVisible(!document.hidden);
    const motion = () => setReduced(!!media?.matches);
    document.addEventListener("visibilitychange", visibility);
    media?.addEventListener("change", motion);
    const observer =
      typeof IntersectionObserver === "function"
        ? new IntersectionObserver(([entry]) => setInView(entry.isIntersecting))
        : null;
    if (surface.current) observer?.observe(surface.current);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      media?.removeEventListener("change", motion);
      observer?.disconnect();
    };
  }, [surface]);
  const playing = active && visible && inView && !reduced;
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => setRunner(cycle.current()), animalSwitchMs);
    return () => clearInterval(timer);
  }, [playing]);
  return { runner, playing };
}
