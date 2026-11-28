(() => {
  'use strict';

  const maxFrameUnits = 32768;
  const maxHistoryUnits = 262144;
  const states = new WeakMap();
  const byId = id => document.getElementById(id);
  let current;
  let selectedFrame;
  let displayedPastes;

  function visibleText(terminal) {
    const buffer = terminal.buffer.active;
    let text = '';
    for (let row = 0; row < terminal.rows; row++) {
      const line = buffer.getLine(buffer.viewportY + row);
      if (!line) break;
      if (row) text += '\n';
      text += line.translateToString(true);
      if (text.length > maxFrameUnits) return text.slice(0, maxFrameUnits - 1) + '…';
    }
    return text.trimEnd();
  }

  function capture(terminal, state) {
    const text = visibleText(terminal);
    if (text === state.frames.at(-1)?.text) return;
    state.frames.push({ time: Date.now(), text });
    state.units += text.length;
    while (state.frames.length > 120 || state.units > maxHistoryUnits) {
      state.units -= state.frames.shift().text.length;
    }
    if (isViewing(terminal)) render();
  }

  function stopReplay(state) {
    clearTimeout(state.timer);
    state.timer = null;
    for (const item of state.subscriptions) item.dispose();
    state.subscriptions = [];
    state.frames = [];
    state.units = 0;
  }

  function startReplay(terminal, state) {
    const schedule = () => {
      if (state.timer !== null) return;
      state.timer = setTimeout(() => {
        state.timer = null;
        capture(terminal, state);
      }, 250);
    };
    state.subscriptions = [terminal.onWriteParsed(schedule), terminal.onScroll(schedule), terminal.onResize(schedule)];
    capture(terminal, state);
  }

  function rememberPaste(terminal, text) {
    const state = states.get(terminal);
    if (!state?.keepPastes || !text || text.length > 4096) return;
    state.pastes = [text, ...state.pastes.filter(item => item !== text)].slice(0, 20);
    if (isViewing(terminal)) render();
  }

  function ensureState(terminal) {
    let state = states.get(terminal);
    if (state) return state;
    state = { frames: [], pastes: [], keepPastes: false, subscriptions: [], timer: null, units: 0 };
    states.set(terminal, state);
    const textarea = terminal.textarea;
    const nativePaste = event => {
      if (state.keepPastes && event.isTrusted) rememberPaste(terminal, event.clipboardData?.getData('text/plain'));
    };
    textarea.addEventListener('paste', nativePaste, true);
    terminal.loadAddon({
      activate() {},
      dispose() {
        stopReplay(state);
        state.pastes = [];
        states.delete(terminal);
        textarea.removeEventListener('paste', nativePaste, true);
        if (isViewing(terminal)) clearPreview();
      },
    });
    return state;
  }

  function isViewing(terminal) {
    return byId('history-details').open && byId('actions-dialog').open && current()?.terminal === terminal;
  }

  function render() {
    const pane = current();
    const state = pane && states.get(pane.terminal);
    const recording = Boolean(state?.subscriptions.length);
    byId('replay-record').disabled = byId('paste-record').disabled = !pane;
    byId('replay-record').checked = recording;
    byId('paste-record').checked = Boolean(state?.keepPastes);
    const frames = state?.frames || [];
    const slider = byId('replay-position');
    const pinned = frames.indexOf(selectedFrame);
    if (pinned < 0) selectedFrame = null;
    const index = pinned < 0 ? frames.length - 1 : pinned;
    const frame = frames[index];
    slider.max = String(Math.max(0, frames.length - 1));
    slider.value = String(Math.max(0, index));
    slider.disabled = frames.length < 2;
    byId('replay-clear').disabled = !frames.length;
    byId('replay-screen').textContent = frame?.text ?? '';
    byId('replay-time').textContent = frame
      ? new Date(frame.time).toLocaleTimeString('zh-CN', { hour12: false, fractionalSecondDigits: 3, hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' · ' + (index + 1) + '/' + frames.length
      : '暂无快照';
    const choices = state?.pastes || [];
    const list = byId('paste-list');
    if (displayedPastes !== choices) {
      const previous = displayedPastes?.[list.selectedIndex];
      // Store only a short display preview in the DOM. Keep full multiline
      // data in the bounded list, including when two previews look alike.
      list.replaceChildren(...choices.map((text, i) => new Option(text.replace(/\s+/g, ' ').slice(0, 64), String(i))));
      if (choices.length) list.selectedIndex = Math.max(0, choices.indexOf(previous));
      displayedPastes = choices;
    }
    list.disabled = byId('paste-clear').disabled = !choices.length;
    byId('paste-again').disabled = !choices.length || pane?.state !== 'running';
  }

  function clearPreview() {
    selectedFrame = null;
    displayedPastes = null;
    byId('replay-screen').textContent = '';
    byId('replay-time').textContent = '';
    byId('paste-list').replaceChildren();
  }

  function bind(getPane) {
    current = getPane;
    const details = byId('history-details');
    details.addEventListener('toggle', () => { if (details.open) render(); else clearPreview(); });
    byId('actions-dialog').addEventListener('close', () => { details.open = false; clearPreview(); });
    byId('replay-record').onchange = event => {
      const pane = current();
      if (!pane) return;
      const state = ensureState(pane.terminal);
      if (event.target.checked) startReplay(pane.terminal, state);
      else stopReplay(state);
      selectedFrame = null;
      render();
    };
    byId('replay-clear').onclick = () => {
      const state = states.get(current()?.terminal);
      if (state) { clearTimeout(state.timer); state.timer = null; state.frames = []; state.units = 0; }
      selectedFrame = null;
      render();
    };
    byId('replay-position').oninput = event => {
      const frames = states.get(current()?.terminal)?.frames || [];
      const index = Number(event.target.value);
      selectedFrame = index === frames.length - 1 ? null : frames[index];
      render();
    };
    byId('paste-record').onchange = event => {
      const pane = current();
      if (!pane) return;
      const state = ensureState(pane.terminal);
      state.keepPastes = event.target.checked;
      if (!state.keepPastes) state.pastes = [];
      render();
    };
    byId('paste-clear').onclick = () => {
      const state = states.get(current()?.terminal);
      if (state) state.pastes = [];
      render();
    };
    byId('paste-again').onclick = () => {
      const pane = current();
      const text = states.get(pane?.terminal)?.pastes[byId('paste-list').selectedIndex];
      if (pane?.state !== 'running' || !text) return;
      byId('actions-dialog').close();
      pane.terminal.focus();
      pane.terminal.paste(text);
    };
  }

  function refresh() {
    if (byId('history-details').open && byId('actions-dialog').open) render();
  }

  window.BrclioTerminalHistory = Object.freeze({ bind, rememberPaste, refresh });
})();
