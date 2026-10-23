import { useEffect, useId, useRef, useState } from "react";
import {
  AVATAR_STAGE_SIZE,
  createAvatarCrop,
  getAvatarCropLimits,
  getAvatarImageRect,
  moveAvatarCrop,
  resizeAvatarCrop,
  zoomAvatarCrop,
} from "./avatar-crop.js";
import {
  drawAvatarCrop,
  loadAvatarImage,
  prepareAvatarImage,
} from "./avatar-image.js";
import "./avatar-crop.css";

export default function AvatarCropper({
  file,
  onConfirm,
  onCancel,
  onBusyChange,
}) {
  const [image, setImage] = useState(null);
  const [crop, setCrop] = useState(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const stage = useRef(null);
  const picture = useRef(null);
  const preview = useRef(null);
  const selection = useRef(null);
  const gesture = useRef(null);
  const generation = useRef(0);
  const submitting = useRef(false);
  const helpId = useId();

  useEffect(() => {
    let cancelled = false;
    let decoded;
    generation.current++;
    setImage(null);
    setCrop(null);
    setError("");
    gesture.current = null;
    loadAvatarImage(file)
      .then((bitmap) => {
        if (cancelled) {
          bitmap.close();
          return;
        }
        decoded = bitmap;
        setImage(bitmap);
        setCrop(createAvatarCrop(bitmap));
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
      generation.current++;
      decoded?.close();
    };
  }, [file]);

  useEffect(() => {
    if (!image || !crop) return;
    try {
      const context = picture.current?.getContext("2d");
      if (!context) throw new Error("无法处理头像图片，请重试。");
      const rect = getAvatarImageRect(image, crop);
      context.clearRect(0, 0, AVATAR_STAGE_SIZE, AVATAR_STAGE_SIZE);
      context.drawImage(image, rect.x, rect.y, rect.width, rect.height);
      drawAvatarCrop(preview.current?.getContext("2d"), image, crop, 96);
    } catch (err) {
      setError(err.message);
    }
  }, [image, crop]);

  useEffect(() => {
    if (image) selection.current?.focus({ preventScroll: true });
  }, [image]);

  function point(event) {
    const rect = stage.current.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * AVATAR_STAGE_SIZE,
      y: ((event.clientY - rect.top) / rect.height) * AVATAR_STAGE_SIZE,
    };
  }

  function start(event, resize = false) {
    if (
      saving ||
      !image ||
      gesture.current ||
      event.button !== 0 ||
      event.isPrimary === false
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    selection.current.focus({ preventScroll: true });
    selection.current.setPointerCapture?.(event.pointerId);
    gesture.current = {
      id: event.pointerId,
      resize,
      point: point(event),
      crop,
    };
  }

  function move(event) {
    const active = gesture.current;
    if (!active || active.id !== event.pointerId || saving) return;
    event.preventDefault();
    const next = point(event);
    const previous = active.point;
    setCrop(
      active.resize
        ? resizeAvatarCrop(
            image,
            active.crop,
            active.crop.radius +
              Math.hypot(next.x - active.crop.x, next.y - active.crop.y) -
              Math.hypot(
                previous.x - active.crop.x,
                previous.y - active.crop.y,
              ),
          )
        : moveAvatarCrop(
            image,
            active.crop,
            next.x - previous.x,
            next.y - previous.y,
          ),
    );
  }

  function finish(event) {
    if (gesture.current?.id === event.pointerId) {
      gesture.current = null;
      if (selection.current?.hasPointerCapture?.(event.pointerId))
        selection.current.releasePointerCapture(event.pointerId);
    }
  }

  function keyMove(event) {
    if (saving || event.target !== event.currentTarget) return;
    const directions = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const direction = directions[event.key];
    if (!direction) return;
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? 10 : 1;
    setCrop((current) =>
      moveAvatarCrop(image, current, direction[0] * step, direction[1] * step),
    );
  }

  async function confirm() {
    if (!image || !crop || submitting.current) return;
    submitting.current = true;
    setSaving(true);
    onBusyChange?.(true);
    setError("");
    const version = generation.current;
    try {
      const blob = await prepareAvatarImage(image, crop);
      if (version !== generation.current) return;
      await onConfirm(blob);
    } catch (err) {
      if (version === generation.current) setError(err.message);
    } finally {
      submitting.current = false;
      if (version === generation.current) setSaving(false);
      onBusyChange?.(false);
    }
  }

  const limits = image && crop ? getAvatarCropLimits(image, crop) : null;
  return (
    <section
      className="avatar-cropper"
      role="region"
      aria-label="裁剪头像"
      aria-busy={saving}
    >
      <h3>调整头像</h3>
      <p id={helpId}>
        拖动圆圈选择位置，拖动圆圈右下角或使用滑块调整大小。选中圆圈后可用方向键微调，按住
        Shift 加快移动。
      </p>
      {image && crop ? (
        <>
          <div ref={stage} className="avatar-crop-stage">
            <canvas
              ref={picture}
              width={AVATAR_STAGE_SIZE}
              height={AVATAR_STAGE_SIZE}
              aria-hidden="true"
            />
            <div
              ref={selection}
              className="avatar-crop-selection"
              role="group"
              aria-label="圆形裁剪选区"
              aria-describedby={helpId}
              aria-disabled={saving}
              tabIndex={saving ? -1 : 0}
              style={{
                left: `${((crop.x - crop.radius) / AVATAR_STAGE_SIZE) * 100}%`,
                top: `${((crop.y - crop.radius) / AVATAR_STAGE_SIZE) * 100}%`,
                width: `${((crop.radius * 2) / AVATAR_STAGE_SIZE) * 100}%`,
                height: `${((crop.radius * 2) / AVATAR_STAGE_SIZE) * 100}%`,
              }}
              onPointerDown={(event) => start(event)}
              onPointerMove={move}
              onPointerUp={finish}
              onPointerCancel={finish}
              onLostPointerCapture={finish}
              onKeyDown={keyMove}
            >
              <button
                type="button"
                className="avatar-crop-resize"
                aria-label="拖动调整圆圈大小"
                tabIndex={-1}
                disabled={saving}
                onPointerDown={(event) => start(event, true)}
              />
            </div>
          </div>
          <div className="avatar-crop-controls">
            <fieldset disabled={saving}>
              <label>
                <span>
                  原图缩放 <output>{Math.round(crop.zoom * 100)}%</output>
                </span>
                <input
                  type="range"
                  aria-label="原图缩放"
                  min="1"
                  max="4"
                  step="0.01"
                  value={crop.zoom}
                  onChange={(event) =>
                    setCrop((current) =>
                      zoomAvatarCrop(
                        image,
                        current,
                        Number(event.target.value),
                      ),
                    )
                  }
                />
              </label>
              <label>
                <span>圆圈大小</span>
                <input
                  type="range"
                  aria-label="圆圈大小"
                  min={limits.minRadius}
                  max={limits.maxRadius}
                  step="any"
                  value={crop.radius}
                  onChange={(event) =>
                    setCrop((current) =>
                      resizeAvatarCrop(
                        image,
                        current,
                        Number(event.target.value),
                      ),
                    )
                  }
                />
              </label>
            </fieldset>
            <div className="avatar-crop-preview">
              <canvas
                ref={preview}
                width="96"
                height="96"
                role="img"
                aria-label="头像预览"
              />
              <span>头像预览</span>
            </div>
          </div>
        </>
      ) : (
        !error && <p role="status">正在读取图片…</p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <p className="avatar-crop-note">仅保存圆圈内的内容，圈外为透明背景。</p>
      <div className="avatar-crop-actions">
        <button
          type="button"
          className="secondary"
          disabled={saving}
          onClick={onCancel}
        >
          取消裁剪
        </button>
        <button
          type="button"
          className="primary"
          disabled={saving || !image || !crop}
          onClick={confirm}
        >
          {saving ? "保存中…" : "确认头像"}
        </button>
      </div>
    </section>
  );
}
