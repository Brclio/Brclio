'use strict';

const { createHash } = require('node:crypto');
const path = require('node:path');
const guestPartition = 'persist:brclio-terminal';
const reader = path.join(__dirname, 'unbound-transfer.html');
const checksum = text => createHash('sha256').update(text).digest('hex');

function registerUnboundTransfer({ handle, WebContentsView, dialog, getView, getOwner, viewUserId, localUser }) {
  let moving = false;
  handle('unbound-transfer', async (operation, userId) => {
    if (!['available', 'move'].includes(operation) || typeof userId !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(userId)) {
      throw new Error('迁移请求无效。');
    }
    const origin = getView();
    const current = () => !!origin && getView() === origin && !origin.webContents.isDestroyed() && viewUserId() === userId;
    async function confirmIdentity() {
      const user = current() ? await localUser() : null;
      if (user?.id !== userId || !current()) throw new Error('终端账号已变化，请重新确认。');
      return user;
    }
    const user = await confirmIdentity();
    const digest = checksum(userId);
    const isMove = operation === 'move';
    if (isMove && moving) throw new Error('正在移入本机配置。');
    if (isMove) moving = true;
    let contents;
    try {
      if (isMove) {
        const choice = await dialog.showMessageBox(getOwner(), {
          type: 'question', title: '移入未关联的本机配置', message: '将此设备未关联的终端资料移入当前 Brclio 账号？',
          detail: '已确认的账号 · ' + (user.email || userId) + '\n移入成功后，原访客资料会从未登录状态移除。',
          buttons: ['取消', '移入当前账号'], cancelId: 0, defaultId: 0, noLink: true,
        });
        if (choice.response !== 1) return { moved: false };
        await confirmIdentity();
      }
      const hidden = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
        webSecurity: true, partition: guestPartition } });
      contents = hidden.webContents;
      if (contents.session === origin.webContents.session) throw new Error('必须从当前账号的独立终端移入资料。');
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
      contents.on('will-navigate', event => event.preventDefault());
      await contents.loadFile(reader);
      await confirmIdentity();
      if (!isMove) {
        const available = await contents.executeJavaScript('window.BrclioUnboundReader.available(' + JSON.stringify(digest) + ')');
        await confirmIdentity();
        return { available: available === true };
      }
      const snapshot = await contents.executeJavaScript('window.BrclioUnboundReader.claim(' + JSON.stringify(digest) + ')');
      let startedCopy = false;
      try {
        const data = JSON.stringify(snapshot);
        const revision = checksum(data);
        await confirmIdentity();
        startedCopy = true;
        const written = await origin.webContents.executeJavaScript('(() => { try { window.BrclioTerminalPartitions.importUnbound(' +
          JSON.stringify(userId) + ',' + data + ',' + JSON.stringify(revision) +
          '); return {ok:true}; } catch(error) { return {ok:false, error:String(error.message).slice(0, 200)}; } })()');
        if (!written.ok) {
          startedCopy = false;
          throw new Error(written.error || '写入当前账号资料失败。');
        }
        await confirmIdentity();
        const cleared = await contents.executeJavaScript('window.BrclioUnboundReader.commit(' + JSON.stringify(digest) + ',' + data + ')');
        if (!cleared) throw new Error('访客资料在迁移期间发生变化，原资料已保留。请重新核对后移入。');
        await confirmIdentity();
        return { moved: true };
      } catch (error) {
        // Once a destination write has begun it may already be durable. Keep
        // the claim for this account to resume, even if the old view is closed.
        if (!startedCopy) await contents.executeJavaScript('window.BrclioUnboundReader.release(' + JSON.stringify(digest) + ')').catch(() => {});
        throw error;
      }
    } finally {
      if (contents && !contents.isDestroyed()) contents.close();
      if (isMove) moving = false;
    }
  });
}

module.exports = { registerUnboundTransfer };
