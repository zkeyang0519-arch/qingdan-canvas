import { gridHeight, pixelTile, planeNames } from "./island-pixel-garden.js";
import sizeLimits from "../../shared/island-size.json" with { type: "json" };

const seasonMs = 18000;
const baseSpeed = 24 / (46 / gridHeight);
const depth = { far: 0.26, mid: 0.57, near: 1 };
const mod = (value, period) => ((value % period) + period) % period;

function align(animation, time, rate, running) {
  animation.playbackRate = rate;
  if (!running) {
    animation.pause();
    animation.currentTime = time;
    return;
  }
  animation.currentTime = time;
  animation.play();
  const frame = document.timeline.currentTime;
  if (frame !== null) animation.startTime = frame - time / rate;
}

function makeTrack(layer, width, height, density) {
  const canvas = document.createElement("canvas");
  canvas.dataset.plane = layer;
  const tileWidth = pixelTile(0, layer).width;
  const period = (tileWidth * height) / gridHeight;
  const periodPixels = Math.max(1, Math.round(period * density));
  const texel = period / periodPixels;
  // The belt also covers the widest allowed cabin while its edge is dragged.
  const span = Math.max(
    width,
    sizeLimits.top.width + sizeLimits.maxExtraWidth + 36,
  );
  canvas.width = Math.ceil(span / texel) + periodPixels + 8;
  canvas.height = Math.max(1, Math.round(height * density));
  canvas.style.width = canvas.width * texel + "px";
  canvas.style.left = -4 * texel + "px";
  const speed = baseSpeed * depth[layer];
  const duration = (tileWidth / speed) * 1000;
  const scroll = canvas.animate(
    [
      { transform: "translate3d(0px,0,0)" },
      { transform: "translate3d(" + -period + "px,0,0)" },
    ],
    { duration, easing: "linear", iterations: Infinity },
  );
  function paint(season) {
    // Nearest-neighbor baking keeps the art crisp. The compositor samples
    // the finished display-resolution canvas at fractional screen positions.
    const tile = document.createElement("canvas");
    tile.width = periodPixels;
    tile.height = canvas.height;
    const brush = tile.getContext("2d");
    brush.imageSmoothingEnabled = false;
    brush.drawImage(pixelTile(season, layer), 0, 0, tile.width, tile.height);
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(4, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = ctx.createPattern(tile, "repeat-x");
    ctx.fillRect(-4, 0, canvas.width, canvas.height);
    ctx.restore();
  }
  return {
    canvas,
    paint,
    scroll,
    duration,
    offset: layer === "near" ? (3 / speed) * 1000 : 0,
  };
}

export function createPixelScene(node) {
  let groups = [],
    fade,
    season = -1,
    geometry = "";
  let elapsed = 0,
    travel = 0,
    start = null,
    speed = 24,
    reverse = false;
  let enabled = false,
    visible = true,
    boundary,
    timeout;
  const clock = () => {
    const now = performance.now();
    if (start !== null) {
      const dt = now - start;
      elapsed = mod(elapsed + dt, 4 * seasonMs);
      travel += ((dt * speed) / 24) * (reverse ? -1 : 1);
      start = now;
    }
  };
  function paintSeason() {
    const next = Math.floor(elapsed / seasonMs);
    if (next === season) return;
    season = next;
    for (const [index, group] of groups.entries()) {
      for (const track of group.tracks) track.paint((next + index) % 4);
    }
    node.dataset.season = String(next);
  }
  function refresh(syncScroll = false) {
    clock();
    clearTimeout(boundary);
    if (!fade) return;
    const running =
      enabled && visible && !document.hidden && node.clientHeight > 0;
    const changed = running !== (start !== null);
    start = running ? performance.now() : null;
    paintSeason();
    align(fade, elapsed % seasonMs, 1, running);
    if (changed || syncScroll) {
      for (const { tracks } of groups)
        for (const { scroll, duration, offset } of tracks) {
          scroll.effect.updateTiming({
            direction: reverse ? "reverse" : "normal",
          });
          align(
            scroll,
            mod((reverse ? -1 : 1) * (travel + offset), duration),
            speed / 24,
            running,
          );
        }
    }
    node.dataset.playing = String(running);
    if (running)
      boundary = setTimeout(
        () => refresh(),
        Math.ceil(seasonMs - (elapsed % seasonMs)),
      );
  }
  function clear() {
    fade?.cancel();
    for (const { tracks } of groups)
      for (const track of tracks) track.scroll.cancel();
  }
  function resize() {
    const width = node.clientWidth,
      height = node.clientHeight;
    const density = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    if (!width || !height) {
      refresh();
      return;
    }
    const key = height + "/" + density;
    if (key === geometry) {
      if (enabled && visible && !document.hidden && start === null) refresh();
      return;
    }
    geometry = key;
    clear();
    groups = [0, 1].map(() => {
      const group = document.createElement("div");
      group.className = "island-pixel-season";
      const tracks = planeNames.map((name) =>
        makeTrack(name, width, height, density),
      );
      group.append(...tracks.map((track) => track.canvas));
      return { group, tracks };
    });
    node.replaceChildren(...groups.map((item) => item.group));
    fade = groups[1].group.animate(
      [
        { opacity: 0, offset: 0 },
        { opacity: 0, offset: 13 / 18, easing: "ease-in-out" },
        { opacity: 1, offset: 1 },
      ],
      { duration: seasonMs, fill: "both" },
    );
    season = -1;
    refresh(true);
    node.dataset.ready = "true";
  }
  const scheduleResize = () => {
    clearTimeout(timeout);
    timeout = setTimeout(resize, 65);
  };
  const observer = new ResizeObserver(scheduleResize);
  const intersection = new IntersectionObserver(([entry]) => {
    if (visible !== entry.isIntersecting) {
      visible = entry.isIntersecting;
      refresh();
    }
  });
  const visibility = () => refresh();
  observer.observe(node);
  intersection.observe(node);
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("resize", scheduleResize);
  resize();
  return {
    update(playing, rate, reversed) {
      if (enabled === playing && speed === rate && reverse === reversed) return;
      clock();
      enabled = playing;
      speed = rate;
      reverse = reversed;
      refresh(true);
    },
    destroy() {
      clearTimeout(timeout);
      clearTimeout(boundary);
      observer.disconnect();
      intersection.disconnect();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("resize", scheduleResize);
      clear();
    },
  };
}
