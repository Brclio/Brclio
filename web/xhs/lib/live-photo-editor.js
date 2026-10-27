import { normalizeLivePhotoImageEdit, livePhotoImageDimensions, drawEditedLivePhotoImage, fitLivePhotoImageEditAspectRatio } from './live-photo-image-edit.js';

const $ = id => document.getElementById('xhs-live-edit-' + id);
const clone = edit => normalizeLivePhotoImageEdit(edit);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/** Edits are recipes applied to the original File at render time. This dialog
 * never encodes or replaces the source image. Its previews stay small. */
export function openLivePhotoImageEditor({ file, edit, preset = 'free', signal }) {
  if (signal?.aborted) return Promise.resolve(null);
  const dialog = $('dialog'), source = new Image(), url = URL.createObjectURL(file);
  let draft = clone(edit), loaded = false, closed = false, drag, resolveResult;
  const removers = [];
  const listen = (target, name, handler, options) => {
    target.addEventListener(name, handler, options);
    removers.push(() => target.removeEventListener(name, handler, options));
  };
  const finish = result => {
    if (closed) return;
    closed = true;
    removers.forEach(remove => remove());
    source.onload = source.onerror = null; source.src = ''; URL.revokeObjectURL(url);
    if (dialog.open) dialog.close();
    for (const id of ['crop', 'preview']) { const canvas = $(id); canvas.width = canvas.height = 0; }
    resolveResult(result);
  };
  const error = message => { $('status').textContent = message; };
  const ratio = () => {
    const value = $('ratio').value;
    if (value === 'free') return null;
    if (value === 'original') return 1;
    const [w, h] = value.split(':').map(Number);
    const target = draft.rotation % 180 ? h / w : w / h;
    return target * source.naturalHeight / source.naturalWidth;
  };
  const syncFields = () => {
    if (!loaded) return;
    const percent = $('unit').value === 'percent';
    for (const key of ['x', 'y', 'width', 'height']) {
      const dimension = ['x', 'width'].includes(key) ? source.naturalWidth : source.naturalHeight;
      const input = $(key), scale = percent ? 100 : dimension;
      input.value = String(Number((draft.crop[key] * scale).toFixed(percent ? 3 : 0)));
      input.min = ['width', 'height'].includes(key) ? String(percent ? 100 / dimension : 1) : '0';
      input.max = String(scale); input.step = percent ? '0.1' : '1';
    }
    for (const key of ['brightness', 'contrast', 'saturation']) {
      $(key).value = String(Math.round(draft[key] * 100)); $(key + '-value').textContent = `${Math.round(draft[key] * 100)}%`;
    }
    $('flip-x').setAttribute('aria-pressed', String(draft.flipX)); $('flip-y').setAttribute('aria-pressed', String(draft.flipY));
    $('rotation').textContent = `${draft.rotation}°`;
  };
  const render = () => {
    if (closed || !loaded) return;
    const canvas = $('crop'), scale = Math.min(1, 720 / source.naturalWidth, 450 / source.naturalHeight);
    canvas.width = Math.max(1, Math.round(source.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(source.naturalHeight * scale));
    const context = canvas.getContext('2d');
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    const { x, y, width, height } = draft.crop;
    const left = x * canvas.width, top = y * canvas.height, w = width * canvas.width, h = height * canvas.height;
    context.fillStyle = 'rgba(26,26,46,.48)';
    context.fillRect(0, 0, canvas.width, top); context.fillRect(0, top + h, canvas.width, canvas.height - top - h);
    context.fillRect(0, top, left, h); context.fillRect(left + w, top, canvas.width - left - w, h);
    context.strokeStyle = '#2b7fd8'; context.lineWidth = 2; context.strokeRect(left, top, w, h);
    context.strokeStyle = 'rgba(254,252,246,.65)'; context.lineWidth = 1;
    for (const part of [1 / 3, 2 / 3]) {
      context.beginPath(); context.moveTo(left + w * part, top); context.lineTo(left + w * part, top + h); context.stroke();
      context.beginPath(); context.moveTo(left, top + h * part); context.lineTo(left + w, top + h * part); context.stroke();
    }
    for (const [cx, cy] of [[left, top], [left + w, top], [left, top + h], [left + w, top + h]]) {
      context.fillStyle = '#fefcf6'; context.fillRect(cx - 5, cy - 5, 10, 10);
      context.strokeStyle = '#2b7fd8'; context.strokeRect(cx - 5, cy - 5, 10, 10);
    }
    const dimensions = livePhotoImageDimensions(source, draft), preview = $('preview');
    const fit = Math.min(1, 480 / dimensions.width, 230 / dimensions.height);
    preview.width = Math.max(1, Math.round(dimensions.width * fit)); preview.height = Math.max(1, Math.round(dimensions.height * fit));
    drawEditedLivePhotoImage(preview.getContext('2d'), source, { edit: draft, width: preview.width, height: preview.height });
    $('dimensions').textContent = `裁切后 ${dimensions.width} × ${dimensions.height} 像素 · 原图 ${source.naturalWidth} × ${source.naturalHeight}`;
    syncFields();
  };
  const update = value => {
    if (value.crop && loaded) {
      const minimumW = 1 / source.naturalWidth, minimumH = 1 / source.naturalHeight;
      const crop = { ...value.crop, x: clamp(value.crop.x, 0, 1 - minimumW), y: clamp(value.crop.y, 0, 1 - minimumH) };
      crop.width = clamp(crop.width, minimumW, 1 - crop.x); crop.height = clamp(crop.height, minimumH, 1 - crop.y);
      value = { ...value, crop };
    }
    draft = clone(value); render();
  };
  const point = event => {
    const bounds = $('crop').getBoundingClientRect();
    return { x: clamp((event.clientX - bounds.left) / bounds.width, 0, 1), y: clamp((event.clientY - bounds.top) / bounds.height, 0, 1) };
  };
  const applyRatio = () => {
    if (!loaded) return;
    if ($('ratio').value === 'original') { update({ ...draft, crop: { x: 0, y: 0, width: 1, height: 1 } }); return; }
    const selected = ratio(); if (!selected) return;
    const crop = { ...draft.crop }, centerX = crop.x + crop.width / 2, centerY = crop.y + crop.height / 2;
    if (crop.width / crop.height > selected) crop.width = crop.height * selected;
    else crop.height = crop.width / selected;
    crop.x = centerX - crop.width / 2; crop.y = centerY - crop.height / 2;
    update({ ...draft, crop });
  };
  const result = new Promise(resolve => { resolveResult = resolve; });
  $('filename').textContent = file.name; $('status').textContent = '正在读取原图…';
  $('ratio').value = [...$('ratio').options].some(option => option.value === preset) ? preset : 'free'; $('unit').value = 'percent';
  for (const control of dialog.querySelectorAll('input,select,button[data-image-edit-ready]')) control.disabled = true;
  listen(dialog, 'close', () => { if (!dialog.open) finish(null); });
  listen(dialog, 'cancel', event => { event.preventDefault(); finish(null); });
  listen($('cancel'), 'click', () => finish(null)); listen($('close'), 'click', () => finish(null));
  const selectedAspect = () => {
    const preset = $('ratio').value;
    if (preset === 'free') return null;
    if (preset === 'original') return 'original';
    const [w, h] = preset.split(':').map(Number); return w / h;
  };
  const commit = all => {
    if (!loaded) return;
    try {
      const aspectRatio = selectedAspect();
      const target = aspectRatio === 'original' ? (draft.rotation % 180 ? source.naturalHeight / source.naturalWidth : source.naturalWidth / source.naturalHeight) : aspectRatio;
      const saved = target === null ? clone(draft) : fitLivePhotoImageEditAspectRatio(source, draft, target);
      finish({ edit: saved, all, aspectRatio, preset: $('ratio').value });
    } catch (value) { error(value.message); }
  };
  listen($('save'), 'click', () => commit(false));
  listen($('all'), 'click', () => commit(true));
  if (signal) listen(signal, 'abort', () => finish(null), { once: true });
  listen($('ratio'), 'change', applyRatio);
  listen($('unit'), 'change', syncFields);
  for (const key of ['x', 'y', 'width', 'height']) listen($(key), 'change', () => {
    const value = Number($(key).value); if (!Number.isFinite(value)) { syncFields(); return; }
    const dimension = ['x', 'width'].includes(key) ? source.naturalWidth : source.naturalHeight;
    const crop = { ...draft.crop, [key]: value / ($('unit').value === 'percent' ? 100 : dimension) };
    // Numerical entry is intentionally freeform; preset selection remains an
    // explicit operation so changing one coordinate never hides another crop.
    $('ratio').value = 'free'; update({ ...draft, crop });
  });
  for (const key of ['brightness', 'contrast', 'saturation']) listen($(key), 'input', () => update({ ...draft, [key]: Number($(key).value) / 100 }));
  listen($('rotate'), 'click', () => { $('ratio').value = 'free'; update({ ...draft, rotation: (draft.rotation + 90) % 360 }); });
  listen($('flip-x'), 'click', () => update({ ...draft, flipX: !draft.flipX }));
  listen($('flip-y'), 'click', () => update({ ...draft, flipY: !draft.flipY }));
  listen($('reset'), 'click', () => { $('ratio').value = 'free'; update({}); });
  listen($('crop'), 'pointerdown', event => {
    if (!loaded || event.button !== 0) return;
    event.preventDefault(); const at = point(event), crop = draft.crop, bounds = $('crop').getBoundingClientRect();
    const corners = [[crop.x, crop.y], [crop.x + crop.width, crop.y], [crop.x, crop.y + crop.height], [crop.x + crop.width, crop.y + crop.height]];
    const corner = corners.findIndex(([x, y]) => Math.abs(at.x - x) * bounds.width <= 16 && Math.abs(at.y - y) * bounds.height <= 16);
    const inside = at.x >= crop.x && at.x <= crop.x + crop.width && at.y >= crop.y && at.y <= crop.y + crop.height;
    if (corner >= 0) { const opposite = corners[3 - corner]; drag = { mode: 'resize', anchor: { x: opposite[0], y: opposite[1] }, sx: corner % 2 ? 1 : -1, sy: corner >= 2 ? 1 : -1 }; }
    else if (inside) drag = { mode: 'move', at, crop: { ...crop } };
    else drag = { mode: 'new', anchor: at, sx: 1, sy: 1 };
    $('crop').setPointerCapture(event.pointerId);
  });
  listen($('crop'), 'pointermove', event => {
    if (!drag || !loaded) return;
    const at = point(event);
    if (drag.mode === 'move') {
      update({ ...draft, crop: { ...drag.crop, x: clamp(drag.crop.x + at.x - drag.at.x, 0, 1 - drag.crop.width), y: clamp(drag.crop.y + at.y - drag.at.y, 0, 1 - drag.crop.height) } });
      return;
    }
    const anchor = drag.anchor, sx = at.x === anchor.x ? drag.sx : Math.sign(at.x - anchor.x), sy = at.y === anchor.y ? drag.sy : Math.sign(at.y - anchor.y);
    const maxW = sx > 0 ? 1 - anchor.x : anchor.x, maxH = sy > 0 ? 1 - anchor.y : anchor.y;
    let w = Math.max(1 / source.naturalWidth, Math.abs(at.x - anchor.x)), h = Math.max(1 / source.naturalHeight, Math.abs(at.y - anchor.y));
    const selected = ratio();
    if (selected) { w = Math.max(w, h * selected); w = Math.min(w, maxW, maxH * selected); h = w / selected; }
    else { w = Math.min(w, maxW); h = Math.min(h, maxH); }
    update({ ...draft, crop: { x: sx > 0 ? anchor.x : anchor.x - w, y: sy > 0 ? anchor.y : anchor.y - h, width: w, height: h } });
  });
  const stopDrag = event => { drag = null; if ($('crop').hasPointerCapture(event.pointerId)) $('crop').releasePointerCapture(event.pointerId); };
  listen($('crop'), 'pointerup', stopDrag); listen($('crop'), 'pointercancel', stopDrag);
  source.onload = () => {
    if (closed || signal?.aborted) return;
    loaded = true;
    for (const control of dialog.querySelectorAll('input,select,button[data-image-edit-ready]')) control.disabled = false;
    $('status').textContent = '拖动选框移动裁切区域，拖动角点缩放；框外拖动可重新框选。也可用下方数值精确调整。';
    render();
  };
  source.onerror = () => { if (!closed) error('图片读取失败，请关闭后重新选择。'); };
  dialog.showModal(); source.src = url;
  return result;
}

/** Read and release each source separately. Return all recipes before the
 * caller writes any File edits, so a failed/cancelled batch stays atomic. */
export async function prepareLivePhotoImageEdits(files, edit, aspectRatio, { signal, onProgress = () => {} } = {}) {
  const prepared = [];
  for (const [index, file] of files.entries()) {
    signal?.throwIfAborted(); onProgress(index + 1, files.length);
    if (aspectRatio === null) { prepared.push([file, clone(edit)]); continue; }
    const image = new Image(), url = URL.createObjectURL(file);
    try {
      await new Promise((resolve, reject) => {
        const cleanup = () => { image.onload = image.onerror = null; signal?.removeEventListener('abort', canceled); };
        const canceled = () => { cleanup(); reject(signal.reason || new DOMException('图片调整已取消。', 'AbortError')); };
        image.onload = () => { cleanup(); resolve(); };
        image.onerror = () => { cleanup(); reject(new Error(`无法读取 ${file.name}，没有保存本次统一调整。`)); };
        signal?.addEventListener('abort', canceled, { once: true });
        if (signal?.aborted) canceled(); else image.src = url;
      });
      signal?.throwIfAborted();
      const target = aspectRatio === 'original'
        ? (edit.rotation % 180 ? image.naturalHeight / image.naturalWidth : image.naturalWidth / image.naturalHeight) : aspectRatio;
      prepared.push([file, fitLivePhotoImageEditAspectRatio(image, edit, target)]);
    } finally { image.onload = image.onerror = null; image.src = ''; URL.revokeObjectURL(url); }
  }
  signal?.throwIfAborted(); return prepared;
}
