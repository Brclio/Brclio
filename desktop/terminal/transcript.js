'use strict';

window.BrclioTranscript = {
  content(terminal, format) {
    if (format === 'ansi') {
      const serializer = new SerializeAddon.SerializeAddon();
      terminal.loadAddon(serializer);
      try { return serializer.serialize(); } finally { serializer.dispose(); }
    }
    const buffer = terminal.buffer.active;
    const lines = [];
    for (let row = 0; row < buffer.length; row++) {
      const nextWraps = buffer.getLine(row + 1)?.isWrapped;
      lines.push(buffer.getLine(row).translateToString(!nextWraps));
      if (!nextWraps && row + 1 < buffer.length) lines.push('\n');
    }
    const text = lines.join('');
    if (format !== 'html') return text;
    // Treat terminal output as text even when it contains HTML or escape codes.
    const pre = document.createElement('pre');
    pre.textContent = text;
    return '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;"><title>Brclio 终端记录</title></head><body>' +
      pre.outerHTML + '</body></html>';
  },
  bind(activePane, api) {
    const button = document.getElementById('transcript-save');
    const status = document.getElementById('transcript-status');
    button.onclick = async () => {
      const pane = activePane();
      if (!pane) return;
      button.disabled = true;
      try {
        const format = document.getElementById('transcript-format').value;
        const result = await api.saveTranscript(format, this.content(pane.terminal, format));
        status.textContent = result.saved ? '已导出当前窗格。' : '';
      } catch (error) { status.textContent = error.message; }
      finally { button.disabled = false; }
    };
  },
};
