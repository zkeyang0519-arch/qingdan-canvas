import { useEffect, useRef } from "react";
import { ArrowUpRight } from "lucide-react";

const tiles = [
  {
    type: "photo",
    photo: 1,
    label: "VISUAL DIARY / 01",
    x: -1.85,
    y: -0.8,
    tilt: -7,
  },
  { type: "poster", x: -0.95, y: -0.96, tilt: 6 },
  {
    type: "photo",
    photo: 5,
    label: "SOMETHING BEAUTIFUL",
    x: 0.1,
    y: -1.22,
    tilt: -4,
  },
  { type: "book", x: 1.05, y: -0.9, tilt: 7 },
  {
    type: "photo",
    photo: 12,
    label: "COLLECT MOMENTS",
    x: 1.95,
    y: -0.77,
    tilt: -5,
  },
  { type: "sketch", x: -1.85, y: 0.3, tilt: 4 },
  {
    type: "photo",
    photo: 19,
    label: "THE LITTLE THINGS",
    x: -0.95,
    y: 0.24,
    tilt: -5,
  },
  { type: "blue-poster", x: 1.05, y: 0.24, tilt: 5 },
  {
    type: "photo",
    photo: 22,
    label: "SAVED FOR LATER",
    x: 1.95,
    y: 0.38,
    tilt: -6,
  },
  { type: "archive", x: -1.45, y: 1.3, tilt: 5 },
  {
    type: "photo",
    photo: 9,
    label: "SLOW LOOKING",
    x: -0.25,
    y: 1.25,
    tilt: -3,
  },
  { type: "quote", x: 0.85, y: 1.3, tilt: 7 },
];

function TileContent({ tile }) {
  if (tile.type === "photo")
    return (
      <>
        <img
          src={`/opening/${tile.photo}.jpg`}
          alt=""
          decoding="async"
          draggable={false}
          onError={(event) => {
            event.currentTarget.style.visibility = "hidden";
          }}
        />
        <span className="opening-photo-label">{tile.label}</span>
      </>
    );
  if (tile.type === "poster")
    return (
      <>
        <span className="opening-label">DAILY INSPIRATION</span>
        <strong>
          less
          <br />
          but
          <br />
          better.
        </strong>
        <small>给想法一点空间</small>
      </>
    );
  if (tile.type === "blue-poster")
    return (
      <>
        <span className="opening-label">A QUIET MOMENT</span>
        <strong>
          Make
          <br />
          room
          <br />
          for ideas.
        </strong>
      </>
    );
  if (tile.type === "book")
    return (
      <>
        <span className="opening-label">MY BOOKSHELF</span>
        <strong>
          日常
          <br />
          灵感录
        </strong>
        <span className="opening-label">NOTES ON LIFE</span>
      </>
    );
  if (tile.type === "sketch")
    return (
      <>
        <span className="opening-label">随手画 / NO. 03</span>
        <div className="opening-sketch">
          <i />
          <i />
          <i />
          <i />
        </div>
      </>
    );
  if (tile.type === "archive")
    return (
      <>
        <span className="opening-label">PERSONAL ARCHIVE</span>
        <strong>Q / D</strong>
        <span className="opening-label">让喜欢的事，留下来。</span>
      </>
    );
  return (
    <>
      <span className="opening-label">ONE GOOD THOUGHT</span>
      <strong>
        灵感
        <br />
        藏在
        <br />
        日常里。
      </strong>
    </>
  );
}

export default function OpeningCover({ entering, reducedMotion, onEnter }) {
  const cover = useRef(null);
  const entry = useRef(null);
  const frame = useRef(0);
  const pointer = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const resize = () => {
      const element = cover.current;
      const button = entry.current;
      if (!element || !button) return;
      element.style.setProperty(
        "--entry-zoom",
        String(
          Math.max(
            element.clientWidth / (button.offsetWidth || 222),
            element.clientHeight / (button.offsetHeight || 292),
          ) * 1.4,
        ),
      );
    };
    resize();
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      if (frame.current) cancelAnimationFrame(frame.current);
    };
  }, []);

  const paintPointer = () => {
    frame.current = 0;
    cover.current?.style.setProperty("--pointer-x", String(pointer.current.x));
    cover.current?.style.setProperty("--pointer-y", String(pointer.current.y));
  };
  const movePointer = (event) => {
    if (entering || reducedMotion || event.pointerType === "touch") return;
    const box = event.currentTarget.getBoundingClientRect();
    pointer.current = {
      x: ((event.clientX - box.left) / (box.width || 1) - 0.5) * 2,
      y: ((event.clientY - box.top) / (box.height || 1) - 0.5) * 2,
    };
    if (!frame.current) frame.current = requestAnimationFrame(paintPointer);
  };
  const resetPointer = () => {
    pointer.current = { x: 0, y: 0 };
    if (!frame.current) frame.current = requestAnimationFrame(paintPointer);
  };

  return (
    <main
      ref={cover}
      className="opening-cover"
      data-entering={entering}
      aria-label="轻单开场"
      aria-busy={entering}
      onPointerMove={movePointer}
      onPointerLeave={resetPointer}
    >
      <div className="opening-wall" aria-hidden="true">
        {tiles.map((tile, index) => (
          <div
            className={`opening-tile opening-tile-${tile.type}`}
            key={index}
            style={{
              "--tile-x": tile.x,
              "--tile-y": tile.y,
              "--tile-tilt": `${tile.tilt}deg`,
            }}
          >
            <TileContent tile={tile} />
          </div>
        ))}
      </div>
      <div className="opening-vignette" aria-hidden="true" />
      <div className="opening-topline" aria-hidden="true">
        QINGDAN<span>一个装得下灵感的地方</span>
      </div>
      <button
        ref={entry}
        className="opening-entry"
        type="button"
        onClick={onEnter}
        disabled={entering}
        aria-label="打开我的空间，进入轻单"
      >
        <span className="opening-entry-copy">
          <span className="opening-entry-top">QINGDAN</span>
          <span className="opening-title">轻单</span>
          <span className="opening-subtitle">让灵感，有处安放。</span>
          <span className="opening-english">a place for your ideas.</span>
          <span className="opening-entry-bottom">
            <span>打开我的空间</span>
            <span className="opening-arrow">
              <ArrowUpRight size={19} aria-hidden="true" />
            </span>
          </span>
        </span>
      </button>
      <p className="opening-bottomline">你的下一步，从一个想法开始。</p>
      <a
        className="opening-credit"
        href="https://github.com/codrops/IntroGridMotionTransition"
        target="_blank"
        rel="noreferrer"
      >
        图片 · Codrops
      </a>
      <span className="opening-announcement" role="status">
        {entering ? "正在打开轻单" : ""}
      </span>
    </main>
  );
}
