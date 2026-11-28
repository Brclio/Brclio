'use strict';

(() => {
  const dialog = document.createElement('dialog');
  dialog.className = 'connection-sheet';
  dialog.id = 'terminal-lock-dialog';
  dialog.setAttribute('aria-labelledby','terminal-lock-title');
  dialog.innerHTML = `<div class="dialog-head"><h2 id="terminal-lock-title">终端锁</h2><button data-lock="close">关闭</button></div>
    <p>在这台设备启用后，重新进入终端、切换账号、系统锁屏或闲置五分钟均需解锁。</p>
    <form><label>本机终端 PIN <input name="pin" type="password" inputmode="numeric" minlength="6" maxlength="12" pattern="[0-9]{6,12}" autocomplete="off" placeholder="6 至 12 位数字" required></label>
    <label data-lock="repeat">再次输入 PIN <input name="repeat" type="password" inputmode="numeric" autocomplete="off" maxlength="12"></label>
    <label data-lock="biometric"><input name="biometric" type="checkbox"><span></span></label>
    <button data-lock="submit" type="submit"></button></form>
    <button data-lock="now" type="button">立即锁定</button><p role="status"></p>`;
  document.body.append(dialog);
  const field = key => dialog.querySelector('[data-lock="' + key + '"]');
  const form = dialog.querySelector('form'), message = dialog.querySelector('[role=status]');
  const api = window.brclioTerminal;
  field('biometric').querySelector('span').textContent = api?.platform === 'win32' ? '允许 Windows Hello 解锁' : '允许 Touch ID 解锁';
  let enabled, busy;
  function render(state) {
    enabled = state.enabled;
    form.reset();
    field('repeat').hidden = enabled;
    field('biometric').hidden = enabled || !state.biometricAvailable;
    field('now').hidden = !enabled;
    field('submit').textContent = enabled ? '关闭终端锁' : '开启终端锁';
  }
  field('close').onclick = () => dialog.close();
  dialog.onclose = () => { form.reset(); message.textContent = ''; };
  field('now').onclick = async () => {
    try {await api.terminalLock('lock'); dialog.close();}
    catch (error) {message.textContent = error.message;}
  };
  form.onsubmit = async event => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    try {
      if (!enabled && form.elements.pin.value !== form.elements.repeat.value) throw new Error('两次输入的 PIN 不一致。');
      const state = await api.terminalLock(enabled ? 'disable' : 'enable',form.elements.pin.value,form.elements.biometric.checked);
      render(state);
      message.textContent = enabled ? '已启用本机终端锁。' : '已关闭本机终端锁。';
    } catch (error) {message.textContent = error.message;}
    finally {busy = false;}
  };
  window.BrclioTerminalLock = {async open() {
    try { render(await api.terminalLock('status')); dialog.showModal(); }
    catch (error) {message.textContent = error.message; if (!dialog.open) dialog.showModal();}
  }};
})();
