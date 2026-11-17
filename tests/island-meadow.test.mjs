import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createIslandMeadowSurface } from "../src/desktop/island-meadow.js";

async function fixture(t, loader) {
  const dom = new JSDOM('<div id="surface"></div>', {
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const document = window.document;
  const node = document.querySelector("#surface");
  Object.defineProperties(node, {
    clientWidth: { value: 293 },
    clientHeight: { value: 48 },
  });
  let clock = 0,
    hidden = false,
    draws = 0,
    sequence = 0,
    intersect;
  const animations = [],
    intervals = new Map(),
    timeouts = new Map(),
    mediaListeners = new Set();
  const media = {
    matches: false,
    addEventListener: (_, f) => mediaListeners.add(f),
    removeEventListener: (_, f) => mediaListeners.delete(f),
  };
  Object.defineProperty(document, "hidden", { get: () => hidden });
  window.matchMedia = () => media;
  window.Image = class {
    decode() {
      return Promise.resolve();
    }
  };
  window.IntersectionObserver = class {
    constructor(callback) {
      intersect = callback;
    }
    observe() {}
    disconnect() {}
  };
  window.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  t.mock.method(window.performance, "now", () => clock);
  window.setInterval = (f) => {
    intervals.set(++sequence, f);
    return sequence;
  };
  window.clearInterval = (id) => intervals.delete(id);
  window.setTimeout = (f) => {
    timeouts.set(++sequence, f);
    return sequence;
  };
  window.clearTimeout = (id) => timeouts.delete(id);
  window.HTMLCanvasElement.prototype.getContext = () => ({
    drawImage() {
      draws++;
    },
    fillRect() {},
    createLinearGradient: () => ({ addColorStop() {} }),
  });
  window.HTMLCanvasElement.prototype.toDataURL = () =>
    "data:image/png;base64,cGF0dGVybg==";
  window.HTMLElement.prototype.animate = function (frames, timing) {
    const animation = {
      frames,
      timing,
      currentTime: 0,
      playbackRate: 1,
      playState: "running",
      play() {
        this.playState = "running";
      },
      pause() {
        this.playState = "paused";
      },
      cancel() {
        this.playState = "idle";
      },
      updatePlaybackRate(rate) {
        this.playbackRate = rate;
      },
    };
    animations.push(animation);
    return animation;
  };
  const phase = { time: 0, scroll: 0 };
  const surface = createIslandMeadowSurface(node, phase, {
    loadImages:
      loader ||
      (() =>
        Promise.resolve(
          Array.from({ length: 4 }, () => ({
            naturalWidth: 2172,
            naturalHeight: 724,
          })),
        )),
  });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const advance = async (ms) => {
    clock += ms;
    for (const animation of animations) {
      if (animation.playState === "running")
        animation.currentTime += ms * animation.playbackRate;
    }
    for (const tick of [...intervals.values()]) tick();
    for (const [id, callback] of [...timeouts]) {
      timeouts.delete(id);
      callback();
    }
    await flush();
  };
  t.after(() => {
    surface.destroy();
    dom.window.close();
  });
  await flush();
  return {
    node,
    surface,
    phase,
    animations,
    intervals,
    media,
    advance,
    mediaListeners,
    draws: () => draws,
    hide(value) {
      hidden = value;
      document.dispatchEvent(new window.Event("visibilitychange"));
    },
    intersect: (value) => intersect([{ isIntersecting: value }]),
  };
}

test("草地复用缓存平移，调速保持位置，冬到春衔接后清理所有动画", async (t) => {
  const f = await fixture(t);
  f.surface.update({ playing: true, speed: 24 });
  assert.equal(f.node.dataset.ready, "true");
  const scroll = f.animations.find((a) => a.timing.iterations === Infinity);
  const initialDraws = f.draws();
  await f.advance(70000);
  assert.equal(f.node.dataset.season, "3");
  const winterFade = f.animations.at(-1);
  assert.equal(winterFade.currentTime, 16000);
  const position = scroll.currentTime;
  f.surface.update({ speed: 48 });
  assert.equal(scroll.currentTime, position);
  assert.equal(scroll.playbackRate, 2);
  await f.advance(2000);
  assert.equal(f.node.dataset.season, "0");
  assert.equal(f.animations.at(-1).currentTime, 0);
  assert.equal(
    f.draws(),
    initialDraws,
    "animation ticks and speed changes never redraw pixels",
  );
  f.surface.destroy();
  assert.equal(f.intervals.size, 0);
  assert.ok(f.animations.every((a) => a.playState === "idle"));
  assert.equal(f.mediaListeners.size, 0);
});

test("隐藏、离屏、减少动态效果和停止奔跑会暂停并保留四季进度", async (t) => {
  const f = await fixture(t);
  f.surface.update({ playing: true });
  await f.advance(15000);
  f.hide(true);
  assert.equal(f.phase.time, 15000);
  assert.equal(f.intervals.size, 0);
  await f.advance(30000);
  f.hide(false);
  assert.equal(f.phase.time, 15000);
  assert.equal(f.intervals.size, 1);
  f.intersect(false);
  assert.equal(f.intervals.size, 0);
  f.intersect(true);
  assert.equal(f.intervals.size, 1);
  f.media.matches = true;
  f.mediaListeners.forEach((callback) => callback());
  assert.equal(f.intervals.size, 0);
  f.media.matches = false;
  f.mediaListeners.forEach((callback) => callback());
  f.surface.update({ playing: false });
  assert.equal(f.intervals.size, 0);
  assert.ok(
    f.animations
      .filter((a) => a.playState !== "idle")
      .every((a) => a.playState === "paused"),
  );
});

test("图片仍在加载时卸载不会创建迟到的图层或计时器", async (t) => {
  let resolve;
  const f = await fixture(
    t,
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  f.surface.update({ playing: true });
  f.surface.destroy();
  resolve(
    Array.from({ length: 4 }, () => ({
      naturalWidth: 2172,
      naturalHeight: 724,
    })),
  );
  await f.advance(0);
  assert.equal(f.node.children.length, 0);
  assert.equal(f.intervals.size, 0);
  assert.equal(f.animations.length, 0);
});
