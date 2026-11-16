import React from "react";

export default function AnimalRunner({ runner, playing, size = 30 }) {
  const scale = Math.min(size / runner.width, 22 / 36);
  return (
    <span
      className="island-animal"
      aria-hidden="true"
      data-animal={runner.id}
      data-playing={playing}
    >
      <span
        className="island-animal-clip"
        style={{ width: runner.width * scale, height: 36 * scale }}
      >
        <span
          className="island-animal-frames"
          style={{
            width: runner.width * scale * runner.frames,
            maskImage: `url(/animals/runcat/${runner.id}.png)`,
            animationDuration: `${runner.frames * 100}ms`,
            animationTimingFunction: `steps(${runner.frames})`,
          }}
        />
      </span>
    </span>
  );
}
