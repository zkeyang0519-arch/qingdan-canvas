import React, { useEffect, useId, useState } from "react";
import { Plus, X } from "lucide-react";
import {
  activeIslandAppearance,
  defaultIslandAppearance,
  islandAppearancePalettes,
  islandAppearanceVersions,
  normalizeIslandColor,
} from "./island-appearance.js";
import "./color-island.css";

function ColorField({ label, value, onChange, onRemove }) {
  const id = useId();
  const [draft, setDraft] = useState(value.toUpperCase());
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setDraft(value.toUpperCase());
    setInvalid(false);
  }, [value]);
  const edit = (event) => {
    const next = event.target.value;
    setDraft(next);
    const color = normalizeIslandColor(
      next.startsWith("#") ? next : `#${next}`,
    );
    setInvalid(false);
    if (color) onChange(color);
  };
  return (
    <div className="island-palette-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="color"
        aria-label={`${label}颜色`}
        value={value}
        onInput={(event) => onChange(event.currentTarget.value)}
      />
      <input
        className="island-palette-hex"
        type="text"
        aria-label={`${label}色值`}
        aria-invalid={invalid || undefined}
        value={draft}
        maxLength={7}
        spellCheck={false}
        onChange={edit}
        onBlur={() =>
          setInvalid(
            !normalizeIslandColor(draft.startsWith("#") ? draft : `#${draft}`),
          )
        }
      />
      {onRemove && (
        <button type="button" aria-label={`删除${label}`} onClick={onRemove}>
          <X size={13} />
        </button>
      )}
      {invalid && <small role="alert">请输入 6 位 HEX 色值</small>}
    </div>
  );
}

export default function IslandAppearanceSettings({ value, onChange, error }) {
  const presetId = useId(),
    cycleId = useId(),
    glassId = useId();
  const profile = activeIslandAppearance(value);
  const update = (patch) => onChange({ profile: patch });
  const preset =
    islandAppearancePalettes.find(
      (item) =>
        item.colors.join() === profile.colors.join() &&
        item.smallColor === profile.smallColor,
    )?.id || "custom";
  return (
    <section
      className="island-appearance-settings island-palette-settings"
      aria-label="轻岛外观设置"
    >
      <div className="island-appearance-title">
        <strong>外观</strong>
        <button
          type="button"
          onClick={() => update(defaultIslandAppearance.profiles[value.design])}
        >
          恢复当前外观
        </button>
      </div>
      <div
        className="island-design-options"
        role="group"
        aria-label="轻岛外观版本"
      >
        {islandAppearanceVersions.map(({ id, name, detail }) => (
          <button
            type="button"
            key={id}
            aria-label={name}
            aria-pressed={value.design === id}
            onClick={() => onChange({ design: id })}
          >
            <span
              className="island-design-swatch"
              data-design={id}
              style={{
                background: `linear-gradient(120deg, ${value.profiles[id].colors.join(", ")}${value.profiles[id].colors.length === 1 ? `, ${value.profiles[id].colors[0]}` : ""})`,
              }}
              aria-hidden="true"
            />
            <span>
              <strong>{name}</strong>
              <small>{detail}</small>
            </span>
          </button>
        ))}
      </div>
      <label className="island-palette-preset" htmlFor={presetId}>
        配色组合
        <select
          id={presetId}
          aria-label="轻岛配色组合"
          value={preset}
          onChange={(event) => {
            const next = islandAppearancePalettes.find(
              (item) => item.id === event.target.value,
            );
            if (next)
              update({ colors: next.colors, smallColor: next.smallColor });
          }}
        >
          <option value="custom" disabled>
            自定义配色
          </option>
          {islandAppearancePalettes.map(({ id, name }) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <div className="island-palette-colors">
        {profile.colors.map((color, index) => (
          <ColorField
            key={`${value.design}-${index}`}
            label={`色块 ${index + 1}`}
            value={color}
            onChange={(next) =>
              update({
                colors: profile.colors.map((old, i) =>
                  i === index ? next : old,
                ),
              })
            }
            onRemove={
              profile.colors.length > 1
                ? () =>
                    update({
                      colors: profile.colors.filter((_, i) => i !== index),
                    })
                : undefined
            }
          />
        ))}
        <button
          className="island-palette-add"
          type="button"
          disabled={profile.colors.length >= 8}
          onClick={() => update({ colors: [...profile.colors, "#bed1a8"] })}
        >
          <Plus size={13} />
          添加色块
        </button>
      </div>
      <ColorField
        key={`${value.design}-small`}
        label="小舱"
        value={profile.smallColor}
        onChange={(smallColor) => update({ smallColor })}
      />
      <label className="island-palette-motion">
        <span>色块流动</span>
        <input
          type="checkbox"
          aria-label="启用色块流动"
          checked={profile.motion}
          onChange={(event) => update({ motion: event.target.checked })}
        />
      </label>
      <label className="island-appearance-range-label" htmlFor={cycleId}>
        流动周期 <output>{profile.cycle} 秒</output>
      </label>
      <input
        id={cycleId}
        type="range"
        min="3"
        max="12"
        step="0.5"
        aria-label="流动周期"
        value={profile.cycle}
        onChange={(event) => update({ cycle: Number(event.target.value) })}
      />
      {value.design === "glass" && (
        <>
          <label className="island-appearance-range-label" htmlFor={glassId}>
            玻璃强度 <output>{Math.round(profile.glassStrength * 100)}%</output>
          </label>
          <input
            id={glassId}
            type="range"
            min="0"
            max="100"
            step="5"
            aria-label="玻璃强度"
            value={Math.round(profile.glassStrength * 100)}
            onChange={(event) =>
              update({ glassStrength: Number(event.target.value) / 100 })
            }
          />
        </>
      )}
      <p className="island-palette-hint">
        自动保存在本机，每个版本独立记住配色。
      </p>
      {error && (
        <p className="island-appearance-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
