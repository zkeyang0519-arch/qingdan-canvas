import React, { useId } from "react";
import { Minus, Plus } from "lucide-react";
import {
  defaultIslandAppearance,
  islandAppearanceColors,
} from "./island-appearance.js";

export default function IslandAppearanceSettings({ value, onChange, error }) {
  const colorId = useId(),
    transparencyId = useId();
  return (
    <section className="island-appearance-settings" aria-label="轻岛外观设置">
      <div className="island-appearance-title">
        <strong>外观</strong>
        <button type="button" onClick={() => onChange(defaultIslandAppearance)}>
          恢复默认外观
        </button>
      </div>
      <div className="island-appearance-color">
        <label htmlFor={colorId}>颜色</label>
        <input
          id={colorId}
          type="color"
          aria-label="轻岛颜色"
          value={value.color}
          onInput={(event) => onChange({ color: event.currentTarget.value })}
        />
        <output htmlFor={colorId}>{value.color.toUpperCase()}</output>
      </div>
      <div
        className="island-appearance-presets"
        role="group"
        aria-label="轻岛预设颜色"
      >
        {islandAppearanceColors.map(({ name, color }) => (
          <button
            key={color}
            type="button"
            aria-pressed={value.color === color}
            onClick={() => onChange({ color })}
          >
            <span style={{ backgroundColor: color }} aria-hidden="true" />
            {name}
          </button>
        ))}
      </div>
      <label className="island-appearance-range-label" htmlFor={transparencyId}>
        透明度 <output htmlFor={transparencyId}>{value.transparency}%</output>
      </label>
      <div className="island-appearance-range">
        <button
          type="button"
          aria-label="降低轻岛透明度"
          disabled={value.transparency === 0}
          onClick={() => onChange({ transparency: value.transparency - 5 })}
        >
          <Minus size={13} />
        </button>
        <input
          id={transparencyId}
          type="range"
          min="0"
          max="100"
          step="1"
          aria-label="轻岛透明度"
          aria-valuetext={`${value.transparency}% 透明`}
          value={value.transparency}
          onChange={(event) =>
            onChange({ transparency: Number(event.target.value) })
          }
        />
        <button
          type="button"
          aria-label="提高轻岛透明度"
          disabled={value.transparency === 100}
          onClick={() => onChange({ transparency: value.transparency + 5 })}
        >
          <Plus size={13} />
        </button>
      </div>
      {error && (
        <p className="island-appearance-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
