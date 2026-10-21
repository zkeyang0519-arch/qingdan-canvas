import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import ImageContent from "./ImageContent.jsx";
import { clamp, fullCrop, sourcePoint } from "./images.js";
import { id } from "./model.js";

export default forwardRef(function ImageEditor(
  { object, url, mode, tool, onAddMark, onCrop },
  ref,
) {
  const [pending, setPending] = useState(null),
    [crop, setCrop] = useState(object.crop || fullCrop()),
    [square, setSquare] = useState(false),
    [text, setText] = useState(null);
  const gesture = useRef(null),
    surface = useRef(null),
    draft = useRef(crop),
    textDraft = useRef(null),
    textInput = useRef(null),
    composing = useRef(false),
    settlingComposition = useRef(false),
    deferredFinish = useRef(false),
    afterText = useRef(null),
    compositionTimer = useRef(null);
  draft.current = crop;
  const changeCrop = (next) => {
    draft.current = next;
    setCrop(next);
  };
  const finishText = (after) => {
    if (typeof after === "function") afterText.current = after;
    if (composing.current || settlingComposition.current) {
      deferredFinish.current = true;
      textInput.current?.blur();
      return false;
    }
    const item = textDraft.current;
    const value = textInput.current?.value ?? item?.value;
    const done = afterText.current;
    afterText.current = null;
    deferredFinish.current = false;
    textDraft.current = null;
    setText(null);
    if (item && value?.trim())
      onAddMark({
        id: id("mark"),
        kind: "text",
        points: [item.point],
        text: value.trim(),
        color: "#ad7243",
      });
    done?.();
    return true;
  };
  const changeText = (value) => {
    if (!textDraft.current) return;
    const next = { ...textDraft.current, value };
    textDraft.current = next;
    setText(next);
  };
  const cancelGesture = () => {
    if (gesture.current?.crop) changeCrop(gesture.current.crop);
    gesture.current = null;
    setPending(null);
  };
  useEffect(() => {
    window.addEventListener("blur", cancelGesture);
    return () => {
      window.removeEventListener("blur", cancelGesture);
      clearTimeout(compositionTimer.current);
    };
  }, []);
  useImperativeHandle(ref, () => ({
    finishText,
    isComposing: () => composing.current || settlingComposition.current,
    applyCrop: () => onCrop(draft.current),
    cancel: () => {
      textDraft.current = null;
      composing.current = false;
      settlingComposition.current = false;
      deferredFinish.current = false;
      afterText.current = null;
      clearTimeout(compositionTimer.current);
      setText(null);
      cancelGesture();
    },
    freeCrop: () => setSquare(false),
    squareCrop: () => {
      setSquare(true);
      const c = draft.current,
        side = Math.min(
          c.width * object.naturalWidth,
          c.height * object.naturalHeight,
        );
      const width = side / object.naturalWidth,
        height = side / object.naturalHeight;
      changeCrop({
        x: c.x + (c.width - width) / 2,
        y: c.y + (c.height - height) / 2,
        width,
        height,
      });
    },
  }));
  const relative = (e) => {
    const r = surface.current.getBoundingClientRect();
    return {
      x: clamp((e.clientX - r.left) / Math.max(1, r.width)),
      y: clamp((e.clientY - r.top) / Math.max(1, r.height)),
    };
  };
  const down = (e) => {
    e.stopPropagation();
    if (e.button !== 0 || e.target.closest("input")) return;
    e.preventDefault();
    const p = relative(e);
    if (mode === "crop") {
      const corner = e.target.closest("[data-crop-corner]")?.dataset.cropCorner;
      if (!corner && !e.target.closest(".image-crop-box")) return;
      gesture.current = {
        kind: "crop",
        pointerId: e.pointerId,
        start: p,
        crop: { ...draft.current },
        corner: corner || "move",
      };
    } else if (tool === "text") {
      finishText(() => {
        const next = { point: sourcePoint(object, p), position: p, value: "" };
        textDraft.current = next;
        setText(next);
      });
      return;
    } else {
      const point = sourcePoint(object, p),
        mark = {
          id: id("mark"),
          kind: tool,
          points: [point, point],
          color: tool === "highlight" ? "#e9bd35" : "#ad7243",
        };
      gesture.current = {
        kind: "mark",
        pointerId: e.pointerId,
        startClient: { x: e.clientX, y: e.clientY },
        mark,
      };
      setPending(mark);
    }
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const move = (e) => {
    e.stopPropagation();
    const g = gesture.current;
    if (!g || g.pointerId !== e.pointerId) return;
    const p = relative(e);
    if (g.kind === "mark") {
      g.mark = {
        ...g.mark,
        points: [g.mark.points[0], sourcePoint(object, p)],
      };
      setPending(g.mark);
      return;
    }
    const d = g.crop,
      dx = p.x - g.start.x,
      dy = p.y - g.start.y;
    if (g.corner === "move") {
      changeCrop({
        ...d,
        x: clamp(d.x + dx, 0, 1 - d.width),
        y: clamp(d.y + dy, 0, 1 - d.height),
      });
      return;
    }
    let x = d.x,
      y = d.y,
      r = x + d.width,
      b = y + d.height;
    if (g.corner.includes("w")) x = clamp(x + dx, 0, r - 0.01);
    else r = clamp(r + dx, x + 0.01, 1);
    if (g.corner.includes("n")) y = clamp(y + dy, 0, b - 0.01);
    else b = clamp(b + dy, y + 0.01, 1);
    if (square) {
      const side = Math.min(
          (r - x) * object.naturalWidth,
          (b - y) * object.naturalHeight,
        ),
        w = side / object.naturalWidth,
        h = side / object.naturalHeight;
      if (g.corner.includes("w")) x = r - w;
      else r = x + w;
      if (g.corner.includes("n")) y = b - h;
      else b = y + h;
    }
    changeCrop({ x, y, width: r - x, height: b - y });
  };
  const up = (e) => {
    e.stopPropagation();
    const g = gesture.current;
    if (!g || g.pointerId !== e.pointerId) return;
    gesture.current = null;
    setPending(null);
    if (
      g.kind === "mark" &&
      Math.hypot(e.clientX - g.startClient.x, e.clientY - g.startClient.y) >= 3
    )
      onAddMark(g.mark);
    if (e.currentTarget.hasPointerCapture?.(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const display =
    mode === "crop"
      ? { ...object, crop: null, rotation: 0, flipX: false }
      : object;
  return (
    <div
      ref={surface}
      className={`image-editor is-${mode}`}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={(e) => {
        e.stopPropagation();
        cancelGesture();
      }}
      onLostPointerCapture={() => {
        if (gesture.current) cancelGesture();
      }}
    >
      <ImageContent
        object={display}
        url={url}
        pending={pending ? [pending] : []}
      />
      {mode === "crop" && (
        <div className="image-crop-overlay">
          <div className="image-crop-shade">
            <div
              style={{
                left: `${crop.x * 100}%`,
                top: `${crop.y * 100}%`,
                width: `${crop.width * 100}%`,
                height: `${crop.height * 100}%`,
              }}
            />
          </div>
          <div
            className="image-crop-box"
            style={{
              left: `${crop.x * 100}%`,
              top: `${crop.y * 100}%`,
              width: `${crop.width * 100}%`,
              height: `${crop.height * 100}%`,
            }}
          >
            {["nw", "ne", "sw", "se"].map((corner, i) => (
              <button
                key={corner}
                data-crop-corner={corner}
                aria-label={`裁剪${["左上", "右上", "左下", "右下"][i]}角`}
              />
            ))}
            <span>
              {Math.round(crop.width * object.naturalWidth)} ×{" "}
              {Math.round(crop.height * object.naturalHeight)}
            </span>
          </div>
        </div>
      )}
      {text && (
        <input
          ref={textInput}
          autoFocus
          className="image-annotation-input"
          aria-label="图片标注文字"
          placeholder="写一句说明，回车保留"
          maxLength={200}
          style={{
            left: `${Math.min(text.position.x * 100, 55)}%`,
            top: `${Math.min(text.position.y * 100, 85)}%`,
          }}
          value={text.value}
          onChange={(e) => changeText(e.target.value)}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={(e) => {
            composing.current = false;
            settlingComposition.current = true;
            changeText(e.currentTarget.value);
            clearTimeout(compositionTimer.current);
            // The final input event may follow compositionend; retain the input for that event.
            compositionTimer.current = setTimeout(() => {
              settlingComposition.current = false;
              if (deferredFinish.current) finishText();
            }, 0);
          }}
          onBlur={() => finishText()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (
              composing.current ||
              settlingComposition.current ||
              e.nativeEvent.isComposing ||
              e.keyCode === 229
            )
              return;
            if (e.key === "Enter") {
              e.preventDefault();
              finishText();
            }
            if (e.key === "Escape") {
              textDraft.current = null;
              setText(null);
            }
          }}
        />
      )}
    </div>
  );
});
