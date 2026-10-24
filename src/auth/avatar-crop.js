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

function constrain(image, crop) {
  const zoom = clamp(crop.zoom, 1, 4);
  const rect = getAvatarImageRect(image, { ...crop, zoom });
  const limits = getAvatarCropLimits();
  const radius = clamp(crop.radius, limits.minRadius, limits.maxRadius);
  return {
    x: clamp(crop.x, radius, AVATAR_STAGE_SIZE - radius),
    y: clamp(crop.y, radius, AVATAR_STAGE_SIZE - radius),
    radius,
    zoom,
    offsetX: rect.x - (AVATAR_STAGE_SIZE - rect.width) / 2,
    offsetY: rect.y - (AVATAR_STAGE_SIZE - rect.height) / 2,
  };
}

export function createAvatarCrop(image) {
  const rect = getAvatarImageRect(image);
  return constrain(image, {
    x: AVATAR_STAGE_SIZE / 2,
    y: AVATAR_STAGE_SIZE / 2,
    radius: Math.min(rect.width, rect.height) * 0.4,
    zoom: 1,
  });
}

export function getAvatarCropLimits() {
  return {
    minRadius: 16,
    maxRadius: AVATAR_STAGE_SIZE / 2,
  };
}

export function moveAvatarCrop(image, crop, dx, dy) {
  return constrain(image, { ...crop, x: crop.x + dx, y: crop.y + dy });
}

export function resizeAvatarCrop(image, crop, radius) {
  return constrain(image, { ...crop, radius });
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
  const size = (valid.radius * 2) / rect.scale;
  return {
    x: (valid.x - valid.radius - rect.x) / rect.scale,
    y: (valid.y - valid.radius - rect.y) / rect.scale,
    size,
  };
}
