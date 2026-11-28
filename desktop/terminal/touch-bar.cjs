'use strict';

// These actions also have ordinary toolbar buttons on every desktop platform.
function terminalTouchBar(perform, getTouchBar = () => require('electron').TouchBar) {
  let target;
  function detach() {
    if (target && !target.isDestroyed()) target.setTouchBar(null);
    target = undefined;
  }
  function attach(window) {
    if (window === target || typeof window?.setTouchBar !== 'function') return;
    detach();
    const TouchBar = getTouchBar();
    const labels = [['new-tab', '新建标签'], ['split-right', '左右分屏'], ['split-down', '上下分屏'],
      ['find', '查找'], ['terminal-actions', '操作']];
    const items = labels.map(([id, label]) => new TouchBar.TouchBarButton({ label, click() {
      if (target === window && !window.isDestroyed() && window.isFocused()) perform(id);
    } }));
    window.setTouchBar(new TouchBar({ items }));
    target = window;
  }
  return { attach, detach };
}

module.exports = { terminalTouchBar };
