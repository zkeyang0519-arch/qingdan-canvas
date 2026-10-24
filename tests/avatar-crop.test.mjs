import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
for (const name of [
  "window",
  "document",
  "HTMLElement",
  "Element",
  "Node",
  "Event",
  "MouseEvent",
  "getComputedStyle",
])
  globalThis[name] = dom.window[name];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
await mkdir(new URL("../.tmp", import.meta.url), { recursive: true });
const output = await mkdtemp(new URL("../.tmp/avatar-crop-", import.meta.url));
after(async () => {
  dom.window.close();
  await rm(output, { recursive: true, force: true });
});

const math = () => import("../src/auth/avatar-crop.js");

test("初始圆形选区映射到原图，保持原图比例", async () => {
  const { createAvatarCrop, getAvatarSourceRect } = await math();
  const image = { width: 400, height: 200 };
  const crop = createAvatarCrop(image);
  assert.deepEqual(crop, {
    x: 160,
    y: 160,
    radius: 64,
    zoom: 1,
    offsetX: 0,
    offsetY: 0,
  });
  assert.deepEqual(getAvatarSourceRect(image, crop), {
    x: 120,
    y: 20,
    size: 160,
  });
});

test("选区可以越过原图留白，放大时自动内移直到顶到编辑区四边", async () => {
  const {
    createAvatarCrop,
    moveAvatarCrop,
    resizeAvatarCrop,
    getAvatarSourceRect,
  } = await math();
  const image = { width: 400, height: 200 };
  const original = createAvatarCrop(image);
  const moved = moveAvatarCrop(image, original, 1000, -1000);
  assert.deepEqual(moved, {
    x: 256,
    y: 64,
    radius: 64,
    zoom: 1,
    offsetX: 0,
    offsetY: 0,
  });
  assert.deepEqual(getAvatarSourceRect(image, moved), {
    x: 240,
    y: -100,
    size: 160,
  });
  const enlarged = resizeAvatarCrop(image, original, 1000);
  assert.equal(enlarged.radius, 160);
  assert.deepEqual(getAvatarSourceRect(image, enlarged), {
    x: 0,
    y: -100,
    size: 400,
  });
  assert.deepEqual(resizeAvatarCrop(image, moved, 1000), enlarged);
});

test("缩放原图会缩小实际取样范围，并限制缩放上下界", async () => {
  const { createAvatarCrop, zoomAvatarCrop, getAvatarSourceRect } =
    await math();
  const image = { width: 400, height: 200 };
  const original = createAvatarCrop(image);
  const zoomed = zoomAvatarCrop(image, original, 2);
  assert.deepEqual(getAvatarSourceRect(image, zoomed), {
    x: 160,
    y: 60,
    size: 80,
  });
  assert.equal(zoomed.radius, 64, "缩放原图时保留屏幕上的圆圈大小");
  assert.equal(zoomAvatarCrop(image, original, 99).zoom, 4);
  assert.equal(zoomAvatarCrop(image, original, 0).zoom, 1);
});

test("放大以圆圈内的主体为中心，靠近原图边缘的内容仍可选择", async () => {
  const {
    createAvatarCrop,
    moveAvatarCrop,
    zoomAvatarCrop,
    getAvatarSourceRect,
  } = await math();
  const image = { width: 400, height: 200 };
  const offCenter = moveAvatarCrop(image, createAvatarCrop(image), -70, 0);
  const zoomed = zoomAvatarCrop(image, offCenter, 4);
  assert.deepEqual(getAvatarSourceRect(image, zoomed), {
    x: 92.5,
    y: 80,
    size: 40,
  });
  assert.equal(zoomed.x, 90, "放大时圆圈中心保持稳定");
  assert.deepEqual(
    getAvatarSourceRect(image, zoomAvatarCrop(image, zoomed, 1)),
    { x: 32.5, y: 20, size: 160 },
  );
  const moved = moveAvatarCrop(image, zoomed, 80, 0);
  assert.deepEqual(
    getAvatarSourceRect(image, zoomAvatarCrop(image, moved, 1)),
    { x: 57.5, y: 20, size: 160 },
  );
});

test("横竖图、极端长宽比及缩放后，圆圈均可到达四边且取样保留比例", async () => {
  const {
    createAvatarCrop,
    moveAvatarCrop,
    resizeAvatarCrop,
    zoomAvatarCrop,
    getAvatarSourceRect,
  } = await math();
  for (const image of [
    { width: 200, height: 400 },
    { width: 100000, height: 1 },
    { width: 1, height: 100000 },
    { width: 1, height: 1 },
  ]) {
    let crop = createAvatarCrop(image);
    for (const zoom of [4, 2, 1]) {
      crop = zoomAvatarCrop(image, crop, zoom);
      crop = moveAvatarCrop(image, crop, 9000, -9000);
      crop = resizeAvatarCrop(image, crop, 9000);
      const source = getAvatarSourceRect(image, crop);
      assert.ok(source.size > 0);
      assert.equal(crop.radius, 160);
      assert.equal(crop.x, 160);
      assert.equal(crop.y, 160);
      assert.ok(Number.isFinite(source.x) && Number.isFinite(source.y));
      assert.ok(source.x < image.width && source.y < image.height);
      assert.ok(source.x + source.size > 0 && source.y + source.size > 0);
    }
  }
});

let componentPromise;
async function component() {
  componentPromise ??= (async () => {
    await build({
      entryPoints: [
        fileURLToPath(
          new URL("../src/auth/AvatarCropper.jsx", import.meta.url),
        ),
      ],
      bundle: true,
      jsx: "automatic",
      packages: "external",
      platform: "node",
      format: "esm",
      loader: { ".css": "empty" },
      outfile: path.join(output, "cropper.mjs"),
    });
    return (await import(pathToFileURL(path.join(output, "cropper.mjs"))))
      .default;
  })();
  return componentPromise;
}

const png = () =>
  new File(
    [
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3WQAAAAASUVORK5CYII=",
        "base64",
      ),
    ],
    "photo.png",
    { type: "image/png" },
  );

async function mount(t, props = {}, imageSize = { width: 400, height: 200 }) {
  const AvatarCropper = await component();
  const host = document.createElement("main");
  document.body.append(host);
  const root = createRoot(host);
  const decoded = [],
    exported = [];
  const priorDecode = globalThis.createImageBitmap;
  globalThis.createImageBitmap = async () => {
    const bitmap = {
      ...imageSize,
      closed: 0,
      close() {
        this.closed += 1;
      },
    };
    decoded.push(bitmap);
    return bitmap;
  };
  const contexts = new WeakMap();
  t.mock.method(window.HTMLCanvasElement.prototype, "getContext", function () {
    if (!contexts.has(this)) {
      const operations = [];
      const context = { operations };
      for (const name of [
        "clearRect",
        "save",
        "restore",
        "beginPath",
        "arc",
        "clip",
        "drawImage",
      ])
        context[name] = (...args) => operations.push([name, ...args]);
      contexts.set(this, context);
    }
    return contexts.get(this);
  });
  t.mock.method(
    window.HTMLCanvasElement.prototype,
    "toBlob",
    function (callback, mime, quality) {
      exported.push({
        width: this.width,
        height: this.height,
        operations: contexts.get(this).operations,
        mime,
        quality,
      });
      callback(new Blob(["encoded-avatar"], { type: mime }));
    },
  );
  let current = {
    file: png(),
    onConfirm: async () => {},
    onCancel() {},
    onBusyChange() {},
    ...props,
  };
  await act(async () =>
    root.render(React.createElement(AvatarCropper, current)),
  );
  const stage = host.querySelector(".avatar-crop-stage");
  if (stage)
    stage.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 320,
      height: 320,
    });
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    if (priorDecode) globalThis.createImageBitmap = priorDecode;
    else delete globalThis.createImageBitmap;
  });
  return {
    host,
    decoded,
    exported,
    root,
    render: async (changes) => {
      current = { ...current, ...changes };
      await act(async () =>
        root.render(React.createElement(AvatarCropper, current)),
      );
    },
  };
}

async function range(host, label, value) {
  const input = host.querySelector(`input[aria-label="${label}"]`);
  assert.ok(input, `有可访问的 ${label} 控件`);
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  ).set;
  await act(async () => {
    setter.call(input, String(value));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function pointer(element, type, x, y, pointerType = "mouse") {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, {
    clientX: x,
    clientY: y,
    pointerId: 1,
    isPrimary: true,
    button: 0,
    pointerType,
  });
  await act(async () => element.dispatchEvent(event));
}

async function click(host, text) {
  const button = [...host.querySelectorAll("button")].find(
    (element) => element.textContent === text,
  );
  assert.ok(button, `提供 ${text} 按钮`);
  await act(async () => button.click());
}

test("圆圈大小滑块可选满编辑区，横图导出保留透明留白且不拉伸", async (t) => {
  const f = await mount(t);
  await range(f.host, "圆圈大小", 160);
  const circle = f.host.querySelector('[aria-label="圆形裁剪选区"]');
  assert.equal(circle.style.left, "0%");
  assert.equal(circle.style.top, "0%");
  assert.equal(circle.style.width, "100%");
  assert.equal(circle.style.height, "100%");
  await click(f.host, "确认头像");
  const exported = f.exported[0];
  assert.equal(exported.width, 256);
  assert.equal(exported.height, 256);
  assert.equal(exported.mime, "image/webp");
  assert.equal(exported.quality, 0.85);
  const draw = exported.operations.find(
    (operation) => operation[0] === "drawImage",
  );
  assert.deepEqual(draw.slice(2), [0, 0, 400, 200, 0, 64, 256, 128]);
  const preview = f.host
    .querySelector('[aria-label="头像预览"]')
    .getContext("2d");
  assert.deepEqual(
    preview.operations
      .filter((op) => op[0] === "drawImage")
      .at(-1)
      .slice(2),
    [0, 0, 400, 200, 0, 24, 96, 48],
  );
});

test("竖图扩大至四边后保留左右透明留白", async (t) => {
  const f = await mount(t, {}, { width: 200, height: 400 });
  await range(f.host, "圆圈大小", 160);
  await click(f.host, "确认头像");
  const draw = f.exported[0].operations.find((op) => op[0] === "drawImage");
  assert.deepEqual(draw.slice(2), [0, 0, 200, 400, 64, 0, 128, 256]);
});

test("缩小图片不会缩小已选满的圆圈，放大后的取景与导出一致", async () => {
  const {
    createAvatarCrop,
    resizeAvatarCrop,
    zoomAvatarCrop,
    getAvatarSourceRect,
  } = await math();
  const image = { width: 400, height: 200 };
  const full = resizeAvatarCrop(image, createAvatarCrop(image), 160);
  const zoomed = zoomAvatarCrop(image, full, 4);
  assert.deepEqual(getAvatarSourceRect(image, zoomed), {
    x: 150,
    y: 50,
    size: 100,
  });
  const reduced = zoomAvatarCrop(image, zoomed, 1);
  assert.equal(reduced.radius, 160);
  assert.deepEqual(getAvatarSourceRect(image, reduced), {
    x: 0,
    y: -100,
    size: 400,
  });
});

test("20 MB 原图可拖动、触屏调整和缩放，透明圆形导出为二进制", async (t) => {
  let body;
  const original = png();
  const f = await mount(t, {
    file: new File(
      [original, new Uint8Array(20 * 1024 * 1024 - original.size)],
      "large.png",
      { type: "image/png" },
    ),
    onConfirm: async (blob) => {
      body = blob;
    },
  });
  assert.equal(f.exported.length, 0, "编辑预览不能触发导出上传");
  const circle = f.host.querySelector('[aria-label="圆形裁剪选区"]');
  assert.ok(circle);
  await pointer(circle, "pointerdown", 160, 160);
  await pointer(circle, "pointermove", 210, 150);
  await pointer(circle, "pointerup", 210, 150);
  const handle = f.host.querySelector('[aria-label="拖动调整圆圈大小"]');
  assert.ok(handle);
  const start = 64 / Math.SQRT2;
  await pointer(handle, "pointerdown", 210 + start, 150 + start, "touch");
  await pointer(
    circle,
    "pointermove",
    210 + 40 / Math.SQRT2,
    150 + 40 / Math.SQRT2,
    "touch",
  );
  await pointer(
    circle,
    "pointerup",
    210 + 40 / Math.SQRT2,
    150 + 40 / Math.SQRT2,
    "touch",
  );
  assert.ok(
    Math.abs(
      Number(f.host.querySelector('input[aria-label="圆圈大小"]').value) - 40,
    ) < 1e-8,
  );
  await range(f.host, "原图缩放", 2);
  await click(f.host, "确认头像");
  assert.ok(body instanceof Blob);
  assert.equal(body.type, "image/webp");
  assert.equal(f.exported.length, 1);
  const exported = f.exported[0];
  assert.equal(exported.width, 256);
  assert.equal(exported.height, 256);
  const operations = exported.operations;
  assert.deepEqual(
    operations.find((operation) => operation[0] === "arc"),
    ["arc", 128, 128, 128, 0, Math.PI * 2],
  );
  assert.ok(
    operations.findIndex((operation) => operation[0] === "clearRect") <
      operations.findIndex((operation) => operation[0] === "clip"),
  );
  assert.ok(
    operations.findIndex((operation) => operation[0] === "clip") <
      operations.findIndex((operation) => operation[0] === "drawImage"),
  );
  const draw = operations.find((operation) => operation[0] === "drawImage");
  assert.deepEqual(
    draw.slice(2).map((value) => Math.round(value * 1000) / 1000),
    [237.5, 62.5, 50, 50, 0, 0, 256, 256],
  );
  assert.equal(operations.at(-1)[0], "restore");
});

test("键盘可移动选区和调整范围，上传失败保留当前裁剪并能重试", async (t) => {
  let attempts = 0;
  const f = await mount(t, {
    onConfirm: async () => {
      if (++attempts === 1) throw new Error("上传失败，请重试。");
    },
  });
  const circle = f.host.querySelector('[aria-label="圆形裁剪选区"]');
  await act(async () =>
    circle.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key: "ArrowRight",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  await range(f.host, "圆圈大小", 32);
  await range(f.host, "原图缩放", 2);
  await click(f.host, "确认头像");
  assert.match(f.host.querySelector('[role="alert"]').textContent, /上传失败/);
  assert.equal(
    f.host.querySelector('input[aria-label="圆圈大小"]').value,
    "32",
  );
  assert.equal(f.host.querySelector('input[aria-label="原图缩放"]').value, "2");
  await click(f.host, "确认头像");
  assert.equal(attempts, 2);
  assert.deepEqual(
    f.exported[1].operations
      .find((operation) => operation[0] === "drawImage")
      .slice(2),
    [192.5, 80, 40, 40, 0, 0, 256, 256],
  );
  assert.equal(f.host.querySelector('[role="alert"]'), null);
});

test("换图或关闭编辑器释放原图，取消不导出", async (t) => {
  let cancelled = 0;
  const f = await mount(t, {
    onCancel: () => {
      cancelled++;
    },
  });
  await click(f.host, "取消裁剪");
  assert.equal(cancelled, 1);
  assert.equal(f.exported.length, 0);
  await f.render({ file: png() });
  assert.equal(f.decoded[0].closed, 1);
  await act(async () => f.root.unmount());
  assert.equal(f.decoded[1].closed, 1);
});

test("读取期间关闭后也释放迟到图片", async (t) => {
  const f = await mount(t);
  let resolveImage, decoding;
  const started = new Promise((resolve) => {
    decoding = resolve;
  });
  globalThis.createImageBitmap = () =>
    new Promise((resolve) => {
      resolveImage = resolve;
      decoding();
    });
  await f.render({ file: png() });
  await started;
  await act(async () => f.root.unmount());
  let closed = 0;
  await act(async () =>
    resolveImage({
      width: 400,
      height: 200,
      close() {
        closed++;
      },
    }),
  );
  assert.equal(closed, 1);
});

test("图片编码失败保留裁剪位置，重试前不会提交头像", async (t) => {
  let uploads = 0;
  const f = await mount(t, {
    onConfirm: async () => {
      uploads++;
    },
  });
  const encode = window.HTMLCanvasElement.prototype.toBlob;
  let fail = true;
  t.mock.method(
    window.HTMLCanvasElement.prototype,
    "toBlob",
    function (callback, mime) {
      if (fail) callback(null);
      else encode.call(this, callback, mime);
    },
  );
  await range(f.host, "圆圈大小", 32);
  await click(f.host, "确认头像");
  assert.ok(f.host.querySelector('[role="alert"]'));
  assert.equal(uploads, 0);
  assert.equal(
    f.host.querySelector('input[aria-label="圆圈大小"]').value,
    "32",
  );
  fail = false;
  await click(f.host, "确认头像");
  assert.equal(uploads, 1);
  assert.equal(f.host.querySelector('[role="alert"]'), null);
});

test("超过 20 MB 和无法识别的文件展示错误且不上传", async (t) => {
  const f = await mount(t, {
    file: new File([new Uint8Array(20 * 1024 * 1024 + 1)], "large.png", {
      type: "image/png",
    }),
  });
  assert.match(f.host.querySelector('[role="alert"]').textContent, /20\s*MB/);
  assert.ok(
    [...f.host.querySelectorAll("button")].find(
      (button) => button.textContent === "确认头像",
    ).disabled,
  );
  await f.render({ file: new File(["bad"], "bad.png", { type: "image/png" }) });
  assert.ok(f.host.querySelector('[role="alert"]'));
  assert.equal(f.exported.length, 0);
  assert.equal(f.decoded.length, 0);
});
