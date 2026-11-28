'use strict';

window.BrclioAdvancedPaste = function installAdvancedPaste({ api, activePane, actions, paste }) {
  const byId = id => document.getElementById('paste-' + id);
  let generation = 0;
  function stop() {
    generation++;
    byId('send').disabled = false;
    byId('cancel').disabled = true;
  }
  function transform(value) {
    let text = value.replace(/\r\n?/g, '\n');
    if (byId('trim').checked) text = text.replace(/\n+$/, '');
    if (byId('convert').value === 'spaces') text = text.replaceAll('\t', '    ');
    if (byId('convert').value === 'base64') {
      const bytes = new TextEncoder().encode(text);
      let latin = '';
      for (let i = 0; i < bytes.length; i += 8192) latin += String.fromCharCode(...bytes.subarray(i, i + 8192));
      text = btoa(latin);
    }
    return text;
  }
  byId('read').onclick = async () => {
    const token = generation;
    try {
      const text = await api.paste();
      if (text.length > 1024 * 1024) throw new Error('单次高级粘贴上限为 1 MiB 文本。');
      if (generation === token && actions.open) byId('preview').value = text;
    } catch (error) { byId('progress').textContent = error.message; }
  };
  byId('cancel').onclick = () => { stop(); byId('progress').textContent = '已停止。'; };
  actions.addEventListener('close', () => { stop(); byId('preview').value = ''; byId('progress').textContent = ''; });
  byId('send').onclick = async () => {
    const pane = activePane();
    if (!pane || pane.state !== 'running' || !byId('delay').reportValidity()) return;
    if (byId('preview').value.length > 1024 * 1024) { byId('progress').textContent = '单次高级粘贴上限为 1 MiB 文本。'; return; }
    const text = transform(byId('preview').value);
    if (!text) return;
    const delay = Number(byId('delay').value);
    const parts = delay ? text.match(/[^\n]*\n|[^\n]+$/g) : [text];
    const token = ++generation;
    byId('send').disabled = true; byId('cancel').disabled = false;
    try {
      for (const [i, part] of parts.entries()) {
        if (token !== generation || pane !== activePane() || pane.state !== 'running') return;
        paste(pane, part);
        await pane.input;
        if (token !== generation) return;
        byId('progress').textContent = (i + 1) + ' / ' + parts.length;
        if (delay && i + 1 < parts.length) await new Promise(resolve => setTimeout(resolve, delay));
      }
      byId('preview').value = '';
      byId('progress').textContent = '粘贴完成。';
    } catch (error) { byId('progress').textContent = error.message; }
    finally { if (generation === token) stop(); }
  };
};
