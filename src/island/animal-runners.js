import { useEffect, useState } from "react";

// RunCat RunnerGallery / Takuto Nakamura (Kyome22), Apache-2.0.
// The original silhouettes are bundled locally; see public/animals/runcat/NOTICE.md.
export const animalRunner = {
  id: "classic-cat",
  name: "小猫",
  width: 63,
  frames: 5,
};

export function useAnimalRunner(active, surface) {
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
  return { runner: animalRunner, playing };
}
