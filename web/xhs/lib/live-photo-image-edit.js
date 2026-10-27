const DEFAULT_CROP = Object.freeze({ x: 0, y: 0, width: 1, height: 1 });
const ROTATIONS = [0, 90, 180, 270];

function object(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
}

function number(value, minimum, maximum, message) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error(message);
  return value;
}

/** All crop coordinates refer to the original image, before rotation or flips. */
export function normalizeLivePhotoImageEdit(edit = {}) {
  object(edit, '图片调整参数无效。');
  const inputCrop = edit.crop === undefined ? DEFAULT_CROP : edit.crop;
  object(inputCrop, '裁切参数无效。');
  const crop = {};
  for (const key of ['x', 'y', 'width', 'height']) {
    crop[key] = number(inputCrop[key] === undefined ? DEFAULT_CROP[key] : inputCrop[key], 0, 1, '裁切范围必须在原图内。');
  }
  if (crop.x >= 1 || crop.y >= 1 || crop.width <= 0 || crop.height <= 0
    || crop.x + crop.width > 1 + Number.EPSILON * 4 || crop.y + crop.height > 1 + Number.EPSILON * 4)
    throw new Error('裁切范围必须在原图内，且宽高大于 0。');

  const rotation = edit.rotation === undefined ? 0 : edit.rotation;
  if (!ROTATIONS.includes(rotation)) throw new Error('旋转角度请选择 0、90、180 或 270 度。');
  const flipX = edit.flipX === undefined ? false : edit.flipX;
  const flipY = edit.flipY === undefined ? false : edit.flipY;
  if (typeof flipX !== 'boolean' || typeof flipY !== 'boolean') throw new Error('图片翻转参数无效。');
  return { crop, rotation, flipX, flipY,
    brightness: number(edit.brightness === undefined ? 1 : edit.brightness, 0.25, 2, '亮度请选择 0.25 至 2。'),
    contrast: number(edit.contrast === undefined ? 1 : edit.contrast, 0.25, 2, '对比度请选择 0.25 至 2。'),
    saturation: number(edit.saturation === undefined ? 1 : edit.saturation, 0, 2, '饱和度请选择 0 至 2。') };
}

function sourceDimensions(image) {
  const width = image?.naturalWidth ?? image?.width;
  const height = image?.naturalHeight ?? image?.height;
  if (![width, height].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('原图尺寸无效。');
  return { width, height };
}

// Snap floating-point noise at exact pixel boundaries before rounding outward.
function pixelBoundary(value) {
  const nearest = Math.round(value);
  return Math.abs(value - nearest) <= Number.EPSILON * Math.max(1, Math.abs(value)) * 8 ? nearest : value;
}

function cropRect(image, crop) {
  const source = sourceDimensions(image);
  const x = Math.min(source.width - 1, Math.floor(pixelBoundary(crop.x * source.width)));
  const y = Math.min(source.height - 1, Math.floor(pixelBoundary(crop.y * source.height)));
  const right = Math.min(source.width, Math.max(x + 1, Math.ceil(pixelBoundary((crop.x + crop.width) * source.width))));
  const bottom = Math.min(source.height, Math.max(y + 1, Math.ceil(pixelBoundary((crop.y + crop.height) * source.height))));
  return { x, y, width: right - x, height: bottom - y };
}

/** Integer source rectangle; outward rounding retains all selected pixels. */
export function livePhotoImageCropRect(image, edit = {}) {
  return cropRect(image, normalizeLivePhotoImageEdit(edit).crop);
}

export function livePhotoImageDimensions(image, edit = {}) {
  const normalized = normalizeLivePhotoImageEdit(edit), rect = cropRect(image, normalized.crop);
  return normalized.rotation % 180 ? { width: rect.height, height: rect.width }
    : { width: rect.width, height: rect.height };
}

/** Fit a final (post-rotation) aspect ratio inside the current source crop.
 * Common rational ratios use exact integer pixel units, so applying one preset
 * across different source sizes produces the same actual output ratio. */
export function fitLivePhotoImageEditAspectRatio(image, edit, aspectRatio) {
  if (typeof aspectRatio !== 'number' || !Number.isFinite(aspectRatio) || aspectRatio <= 0)
    throw new Error('裁切比例必须是大于 0 的有限数值。');
  const normalized = normalizeLivePhotoImageEdit(edit), source = sourceDimensions(image);
  const rect = cropRect(image, normalized.crop);
  const ratio = normalized.rotation % 180 ? 1 / aspectRatio : aspectRatio;
  let unitWidth, unitHeight;
  for (let denominator = 1; denominator <= 1000; denominator++) {
    const numerator = Math.round(ratio * denominator);
    if (numerator > 0 && Number.isSafeInteger(numerator)
      && Math.abs(numerator / denominator - ratio) <= Number.EPSILON * Math.max(1, ratio) * 16) {
      unitWidth = numerator; unitHeight = denominator; break;
    }
  }
  let width, height;
  const count = unitWidth ? Math.floor(Math.min(rect.width / unitWidth, rect.height / unitHeight)) : 0;
  if (count >= 1) {
    width = unitWidth * count; height = unitHeight * count;
  } else {
    // An arbitrary ratio, or an original ratio such as 601:400 in a smaller
    // crop, may have no exact pixel representation. Round the contained frame
    // to its nearest native pixels instead of rejecting a valid smaller crop.
    const fittedWidth = Math.min(rect.width, rect.height * ratio);
    const fittedHeight = Math.min(rect.height, rect.width / ratio);
    if (fittedWidth < 1 || fittedHeight < 1) throw new Error('当前裁切区域过小，无法保留所选比例的完整像素。');
    width = Math.round(fittedWidth); height = Math.round(fittedHeight);
  }
  const centerX = (normalized.crop.x + normalized.crop.width / 2) * source.width;
  const centerY = (normalized.crop.y + normalized.crop.height / 2) * source.height;
  const x = Math.max(rect.x, Math.min(rect.x + rect.width - width, Math.round(centerX - width / 2)));
  const y = Math.max(rect.y, Math.min(rect.y + rect.height - height, Math.round(centerY - height / 2)));
  return { ...normalized, crop: { x: x / source.width, y: y / source.height, width: width / source.width, height: height / source.height } };
}

/** Draw into a caller-sized canvas. Resizing belongs to the caller because it
 * clears the canvas state stack and would defeat save/restore isolation.
 * Flips follow the final, rotated image's horizontal and vertical axes. */
export function drawEditedLivePhotoImage(context, image, { edit, time = 0, duration = 1, motion = 'still', width, height } = {}) {
  if (!context || !['save', 'restore', 'setTransform', 'fillRect', 'translate', 'scale', 'rotate', 'drawImage']
    .every(method => typeof context[method] === 'function')) throw new Error('图片画布不可用。');
  const normalized = normalizeLivePhotoImageEdit(edit), rect = cropRect(image, normalized.crop);
  const native = normalized.rotation % 180 ? { width: rect.height, height: rect.width }
    : { width: rect.width, height: rect.height };
  width ??= native.width; height ??= native.height;
  if (![width, height].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('画布尺寸无效。');
  if (!Number.isFinite(time) || time < 0 || !Number.isFinite(duration) || duration <= 0 || time > duration)
    throw new Error('图片预览时间无效。');
  if (!['still', 'zoom'].includes(motion)) throw new Error('请选择有效的图片动效。');
  const fit = Math.min(width / native.width, height / native.height);
  const zoom = motion === 'zoom' ? 1 + 0.055 * time / duration : 1;
  context.save();
  try {
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalAlpha = 1; context.globalCompositeOperation = 'source-over';
    context.filter = 'none'; context.fillStyle = '#fefcf6';
    context.fillRect(0, 0, width, height);
    context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
    // Apply tone filters only when the user changes a tone setting.
    if (normalized.brightness !== 1 || normalized.contrast !== 1 || normalized.saturation !== 1)
      context.filter = `brightness(${normalized.brightness}) contrast(${normalized.contrast}) saturate(${normalized.saturation})`;
    context.translate(width / 2, height / 2);
    context.scale(fit * zoom * (normalized.flipX ? -1 : 1), fit * zoom * (normalized.flipY ? -1 : 1));
    context.rotate(normalized.rotation * Math.PI / 180);
    context.drawImage(image, rect.x, rect.y, rect.width, rect.height,
      -rect.width / 2, -rect.height / 2, rect.width, rect.height);
  } finally { context.restore(); }
  return { width, height };
}
