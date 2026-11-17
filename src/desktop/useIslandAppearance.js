import { useLayoutEffect, useRef, useState } from "react";
import {
  defaultIslandAppearance,
  islandAppearanceKey,
  loadIslandAppearance,
  normalizeIslandAppearance,
  patchIslandAppearance,
  saveIslandAppearance,
} from "./island-appearance.js";

const changeEvent = "qingdan:island-appearance";

export function useIslandAppearance(enabled) {
  const [value, setValue] = useState(defaultIslandAppearance);
  const [error, setError] = useState("");
  const latest = useRef(value);
  latest.current = value;
  useLayoutEffect(() => {
    if (!enabled) return;
    const accept = (next) => {
      latest.current = normalizeIslandAppearance(next);
      setValue(latest.current);
      setError("");
    };
    try {
      accept(loadIslandAppearance());
    } catch {
      setError("暂时无法读取本机外观，已使用默认外观。");
    }
    const stored = (event) => {
      if (event.key !== islandAppearanceKey && event.key !== null) return;
      try {
        accept(loadIslandAppearance());
      } catch {
        setError("暂时无法读取本机外观，当前显示保持不变。");
      }
    };
    const changed = (event) => accept(event.detail);
    window.addEventListener("storage", stored);
    window.addEventListener(changeEvent, changed);
    return () => {
      window.removeEventListener("storage", stored);
      window.removeEventListener(changeEvent, changed);
    };
  }, [enabled]);

  const update = (patch) => {
    if (!enabled) return;
    const next = patchIslandAppearance(latest.current, patch);
    latest.current = next;
    setValue(next);
    try {
      saveIslandAppearance(next);
      setError("");
      window.dispatchEvent(
        new window.CustomEvent(changeEvent, { detail: next }),
      );
    } catch {
      setError("外观已预览，但暂未保存到本机，请稍后重试。");
    }
  };
  return { value, update, error };
}
