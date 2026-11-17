export const islandMeadowSeasons = ["spring", "summer", "autumn", "winter"].map(
  (season) => `/island/meadow/${season}-v3.webp`,
);
const seasonMs = 18000;
const fadeMs = 5000;
const cycleMs = seasonMs * islandMeadowSeasons.length;
const baseSpeed = 24;
const mod = (value, period) => ((value % period) + period) % period;
let imagePromise;

function loadImages() {
  imagePromise ||= Promise.all(
    islandMeadowSeasons.map(
      (source) =>
        new Promise((resolve, reject) => {
          const image = new window.Image();
          image.onload = () => resolve(image);
          image.onerror = reject;
          image.src = source;
        }),
    ),
  ).catch((error) => {
    imagePromise = null;
    throw error;
  });
  return imagePromise;
}

// Only resize/load uses Canvas. Playback moves predecoded layers with the compositor.
function patternFor(image, width, height, side, document) {
  const tile = document.createElement("canvas");
  tile.width = side
    ? Math.max(
        width,
        Math.round((height * image.naturalWidth) / image.naturalHeight),
      )
    : Math.round(width * 1.12);
  tile.height = height;
  const context = tile.getContext("2d");
  if (!context) throw Error("Canvas unavailable");
  const scale = Math.max(
    tile.width / image.naturalWidth,
    height / image.naturalHeight,
  );
  const sourceWidth = tile.width / scale;
  const sourceHeight = height / scale;
  context.drawImage(
    image,
    (image.naturalWidth - sourceWidth) / 2,
    (image.naturalHeight - sourceHeight) * (side ? 0.5 : 0.67),
    sourceWidth,
    sourceHeight,
    0,
    0,
    tile.width,
    height,
  );
  const feather = Math.round(tile.width * 0.16);
  const period = tile.width - feather;
  const mask = context.createLinearGradient(0, 0, feather, 0);
  mask.addColorStop(0, "#0000");
  mask.addColorStop(1, "#000");
  context.globalCompositeOperation = "destination-in";
  context.fillStyle = mask;
  context.fillRect(0, 0, tile.width, height);
  const pattern = document.createElement("canvas");
  pattern.width = period;
  pattern.height = height;
  const brush = pattern.getContext("2d");
  if (!brush) throw Error("Canvas unavailable");
  brush.drawImage(tile, -period, 0);
  brush.drawImage(tile, 0, 0);
  return { url: pattern.toDataURL("image/png"), period };
}

export function createIslandMeadowSurface(node, phase, dependencies = {}) {
  const document = node.ownerDocument;
  const window = document.defaultView;
  const now = () => window.performance.now();
  const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  let options = {
    playing: false,
    speed: baseSpeed,
    side: false,
    reverse: false,
  };
  let images, view, interval, resizeTimer;
  let disposed = false,
    inView = true,
    sized = false,
    revision = 0;
  let elapsed = phase.time || 0,
    started = null,
    sizeKey = "";
  const time = () =>
    mod(elapsed + (started === null ? 0 : now() - started), cycleMs);
  const canRun = () =>
    !!view &&
    sized &&
    options.playing &&
    inView &&
    !document.hidden &&
    !media?.matches;

  function showSeason(currentTime, force = false) {
    if (!view) return;
    const season = Math.floor(currentTime / seasonMs);
    if (!force && view.season === season) return;
    view.season = season;
    node.dataset.season = String(season);
    view.base.style.backgroundImage = `url("${view.patterns[season].url}")`;
    view.next.style.backgroundImage = `url("${view.patterns[(season + 1) % 4].url}")`;
    view.fade?.cancel();
    view.fade = view.next.animate(
      [
        { opacity: 0, offset: 0 },
        {
          opacity: 0,
          offset: (seasonMs - fadeMs) / seasonMs,
          easing: "ease-in-out",
        },
        { opacity: 1, offset: 1 },
      ],
      { duration: seasonMs, fill: "both" },
    );
    view.fade.pause();
    view.fade.currentTime = mod(currentTime, seasonMs);
    if (canRun()) view.fade.play();
  }

  function sync() {
    elapsed = time();
    phase.time = elapsed;
    started = canRun() ? now() : null;
    window.clearInterval(interval);
    interval = null;
    showSeason(elapsed);
    if (!view) return;
    if (canRun()) {
      view.scroll.play();
      view.fade?.play();
      interval = window.setInterval(() => showSeason(time()), 100);
    } else {
      view.scroll.pause();
      view.fade?.pause();
    }
  }

  async function resize() {
    if (disposed || !images) return;
    const width = node.clientWidth,
      height = node.clientHeight;
    sized = width > 0 && height > 0;
    if (!sized) {
      revision++;
      sizeKey = "";
      sync();
      return;
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const key = [width, height, dpr, options.side, options.reverse].join();
    if (key === sizeKey) return;
    const build = ++revision;
    const patterns = images.map((image) =>
      patternFor(
        image,
        Math.round(width * dpr),
        Math.round(height * dpr),
        options.side,
        document,
      ),
    );
    await Promise.all(
      patterns.map(({ url }) => {
        const image = new window.Image();
        image.src = url;
        return image.decode();
      }),
    );
    if (disposed || build !== revision) return;
    const period = patterns[0].period / dpr;
    const progress = view
      ? Number(view.scroll.currentTime || 0) / view.duration
      : phase.scroll || 0;
    view?.scroll.cancel();
    view?.fade?.cancel();
    const strip = document.createElement("div");
    strip.className = "island-meadow-strip";
    strip.style.width = `${width + period + 1}px`;
    const base = document.createElement("div"),
      next = document.createElement("div");
    base.className = "island-meadow-season";
    next.className = "island-meadow-season island-meadow-next";
    for (const layer of [base, next])
      layer.style.backgroundSize = `${period}px 100%`;
    strip.append(base, next);
    node.replaceChildren(strip);
    const scale = options.side ? height / 86 : width / 293;
    const duration = (period / (baseSpeed * scale)) * 1000;
    const scroll = strip.animate(
      [
        { transform: `translate3d(${options.reverse ? -period : 0}px,0,0)` },
        { transform: `translate3d(${options.reverse ? 0 : -period}px,0,0)` },
      ],
      { duration, iterations: Infinity, easing: "linear" },
    );
    scroll.pause();
    scroll.currentTime = progress * duration;
    scroll.updatePlaybackRate(options.speed / baseSpeed);
    view = { base, next, patterns, scroll, duration, fade: null, season: -1 };
    sizeKey = key;
    node.dataset.ready = "true";
    sync();
  }
  const rebuild = () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => resize().catch(() => {}), 80);
  };
  const observer =
    typeof window.ResizeObserver === "function"
      ? new window.ResizeObserver(rebuild)
      : null;
  observer?.observe(node);
  const intersection =
    typeof window.IntersectionObserver === "function"
      ? new window.IntersectionObserver(([entry]) => {
          inView = entry.isIntersecting;
          sync();
        })
      : null;
  intersection?.observe(node);
  const load = () =>
    (dependencies.loadImages || loadImages)()
      .then((loaded) => {
        if (disposed) return;
        images = loaded;
        return resize();
      })
      .catch(() => {}); // The CSS spring background remains available on load failure.
  const online = () => {
    if (!images) load();
  };
  document.addEventListener("visibilitychange", sync);
  media?.addEventListener?.("change", sync);
  window.addEventListener("resize", rebuild);
  window.addEventListener("online", online);
  load();
  return {
    update(next) {
      next = { ...options, ...next };
      const geometryChanged =
        options.side !== next.side || options.reverse !== next.reverse;
      options = { ...options, ...next };
      view?.scroll.updatePlaybackRate(options.speed / baseSpeed);
      sync();
      if (geometryChanged) rebuild();
    },
    destroy() {
      elapsed = time();
      phase.time = elapsed;
      phase.scroll = view
        ? Number(view.scroll.currentTime || 0) / view.duration
        : phase.scroll || 0;
      disposed = true;
      revision++;
      window.clearInterval(interval);
      window.clearTimeout(resizeTimer);
      view?.scroll.cancel();
      view?.fade?.cancel();
      observer?.disconnect();
      intersection?.disconnect();
      document.removeEventListener("visibilitychange", sync);
      media?.removeEventListener?.("change", sync);
      window.removeEventListener("resize", rebuild);
      window.removeEventListener("online", online);
    },
  };
}
