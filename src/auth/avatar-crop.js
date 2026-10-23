export const AVATAR_STAGE_SIZE = 320;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function getAvatarImageRect(image, crop = { zoom: 1 }) {
  if (!(image.width > 0 && image.height > 0))
    throw new Error("无法读取图片尺寸，请换一张图片。");
  const scale =
    Math.min(
      AVATAR_STAGE_SIZE / image.width,
      AVATAR_STAGE_SIZE / image.height,
    ) * crop.zoom;
  const width = image.width * scale;
  const height = image.height * scale;
  return {
    x: clamp(
      (AVATAR_STAGE_SIZE - width) / 2 + (crop.offsetX || 0),
      Math.min(0, AVATAR_STAGE_SIZE - width),
      Math.max(0, AVATAR_STAGE_SIZE - width),
    ),
    y: clamp(
      (AVATAR_STAGE_SIZE - height) / 2 + (crop.offsetY || 0),
      Math.min(0, AVATAR_STAGE_SIZE - height),
      Math.max(0, AVATAR_STAGE_SIZE - height),
    ),
    width,
    height,
    scale,
  };
}

function bounds(image, crop) {
  const rect = getAvatarImageRect(image, crop);
  const left = Math.max(0, rect.x);
  const top = Math.max(0, rect.y);
  const right = Math.min(AVATAR_STAGE_SIZE, rect.x + rect.width);
  const bottom = Math.min(AVATAR_STAGE_SIZE, rect.y + rect.height);
  const maxRadius = Math.min(right - left, bottom - top) / 2;
  return {
    left,
    top,
    right,
    bottom,
    maxRadius,
    minRadius: Math.min(16, maxRadius / 4),
  };
}

function constrain(image, crop) {
  const zoom = clamp(crop.zoom, 1, 4);
  const rect = getAvatarImageRect(image, { ...crop, zoom });
  const box = bounds(image, { ...crop, zoom });
  const radius = clamp(crop.radius, box.minRadius, box.maxRadius);
  return {
    x: clamp(crop.x, box.left + radius, box.right - radius),
    y: clamp(crop.y, box.top + radius, box.bottom - radius),
    radius,
    zoom,
    offsetX: rect.x - (AVATAR_STAGE_SIZE - rect.width) / 2,
    offsetY: rect.y - (AVATAR_STAGE_SIZE - rect.height) / 2,
  };
}

export function createAvatarCrop(image) {
  return constrain(image, {
    x: AVATAR_STAGE_SIZE / 2,
    y: AVATAR_STAGE_SIZE / 2,
    radius: bounds(image, { zoom: 1 }).maxRadius * 0.8,
    zoom: 1,
  });
}

export function getAvatarCropLimits(image, crop) {
  const box = bounds(image, crop);
  return {
    minRadius: box.minRadius,
    maxRadius: Math.min(
      crop.x - box.left,
      box.right - crop.x,
      crop.y - box.top,
      box.bottom - crop.y,
    ),
  };
}

export function moveAvatarCrop(image, crop, dx, dy) {
  return constrain(image, { ...crop, x: crop.x + dx, y: crop.y + dy });
}

export function resizeAvatarCrop(image, crop, radius) {
  const limits = getAvatarCropLimits(image, crop);
  return { ...crop, radius: clamp(radius, limits.minRadius, limits.maxRadius) };
}

export function zoomAvatarCrop(image, crop, zoom) {
  const nextZoom = clamp(zoom, 1, 4);
  const previous = getAvatarImageRect(image, crop);
  const centered = getAvatarImageRect(image, { zoom: nextZoom });
  const ratio = nextZoom / crop.zoom;
  // Keep the chosen subject under the circle, including subjects near an edge.
  const next = {
    ...crop,
    zoom: nextZoom,
    offsetX: crop.x - (crop.x - previous.x) * ratio - centered.x,
    offsetY: crop.y - (crop.y - previous.y) * ratio - centered.y,
  };
  const rect = getAvatarImageRect(image, next);
  return constrain(image, {
    ...next,
    x: rect.x + (crop.x - previous.x) * ratio,
    y: rect.y + (crop.y - previous.y) * ratio,
  });
}

export function getAvatarSourceRect(image, crop) {
  const valid = constrain(image, crop);
  const rect = getAvatarImageRect(image, valid);
  const size = Math.min(
    image.width,
    image.height,
    (valid.radius * 2) / rect.scale,
  );
  return {
    x: clamp(
      (valid.x - valid.radius - rect.x) / rect.scale,
      0,
      image.width - size,
    ),
    y: clamp(
      (valid.y - valid.radius - rect.y) / rect.scale,
      0,
      image.height - size,
    ),
    size,
  };
}
