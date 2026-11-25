import React, { useEffect, useMemo, useState } from "react";
import { Film, Pause, Play } from "lucide-react";

const duration = 30;
const timecode = (seconds) =>
  "00:" + String(Math.floor(seconds)).padStart(2, "0");

export default function FilmStoryboard({
  images,
  media,
  text = "",
  ratio,
  visible = true,
}) {
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const shots = useMemo(
    () =>
      text.split(/\r?\n/).flatMap((line) => {
        const m = line.match(
          /^\s*(\d+(?:\.\d+)?)\s*(?:–|—|-|至|~)\s*(\d+(?:\.\d+)?)\s*(?:秒|s)\s*[：:]?\s*(.*)$/i,
        );
        return m && +m[2] > +m[1]
          ? [{ start: +m[1], end: +m[2], text: m[3] }]
          : [];
      }),
    [text],
  );
  useEffect(() => {
    if (!visible) {
      setPlaying(false);
      return;
    }
    if (!playing) return;
    let last = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now(),
        elapsed = Math.max(0, now - last) / 1000;
      last = now;
      setPosition((previous) => Math.min(duration, previous + elapsed));
    }, 100);
    const pauseInBackground = () => {
      if (document.hidden) setPlaying(false);
    };
    document.addEventListener("visibilitychange", pauseInBackground);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", pauseInBackground);
    };
  }, [visible, playing]);
  useEffect(() => {
    if (position >= duration) setPlaying(false);
  }, [position]);
  if (!images.length) return null;
  const shot = shots.findIndex(
    (s) =>
      position >= s.start &&
      (position < s.end || (position === duration && s.end === duration)),
  );
  const index =
    shot >= 0 && shots.length > 1 && images.length <= shots.length
      ? Math.round((shot * (images.length - 1)) / (shots.length - 1))
      : Math.min(
          images.length - 1,
          Math.floor((position * images.length) / duration),
        );
  const image = images[index];
  const frameRatio = /^(9:16|16:9|1:1|4:3|3:4|21:9)$/.test(ratio)
    ? ratio.replace(":", "/")
    : "16/9";
  const [width, height] = frameRatio.split("/").map(Number);
  function toggle() {
    if (!playing && position >= duration) setPosition(0);
    setExpanded(true);
    setPlaying(!playing);
  }
  return (
    <section
      className="studio-storyboard"
      aria-label="分镜预演"
      data-expanded={expanded}
    >
      <div
        className="studio-storyboard-frame"
        style={{ "--frame-ratio": frameRatio, "--frame-scale": width / height }}
      >
        <img src={media(image)} alt={image.title} />
        <div className="studio-storyboard-bar">
          <span>
            <Film size={16} />
            分镜预演
          </span>
          <button
            type="button"
            onClick={toggle}
            aria-label={playing ? "暂停分镜预演" : "播放分镜预演"}
          >
            {playing ? <Pause size={15} /> : <Play size={15} />}{" "}
            {playing ? "暂停" : expanded ? "播放" : "播放 30 秒"}
          </button>
        </div>
      </div>
      {expanded && (
        <div className="studio-storyboard-controls">
          <span>{timecode(position)} / 00:30</span>
          <input
            aria-label="分镜播放位置"
            type="range"
            min="0"
            max={duration}
            step=".1"
            value={position}
            onChange={(e) => setPosition(Number(e.target.value))}
          />
          <p>{(shot >= 0 && shots[shot].text) || image.title}</p>
        </div>
      )}
    </section>
  );
}
