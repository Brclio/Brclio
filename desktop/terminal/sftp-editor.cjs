'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { copyBytes } = require('./sftp-protocol.cjs');

const limit = 32 * 1024 * 1024;
const limited = bytes => { if (bytes > limit) throw new Error('编辑文件的上限为 32 MiB。'); };
const isFile = mode => (mode & 0o170000) === 0o100000;

async function digestStream(source, check) {
  const hash = createHash('sha256');
  await copyBytes(source, { async write(data, start, length) {
    hash.update(data.subarray(start, start + length));
    return { bytesWritten: length };
  } }, limited, check);
  return hash.digest('hex');
}

async function withLocal(file, action) {
  const handle = await fs.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (!(await handle.stat()).isFile() || await fs.realpath(file) !== file) throw new Error('本地编辑副本已移动。');
    return await action(handle);
  } finally { await handle.close(); }
}

async function openDraft(pane, name, launch, check) {
  const net = pane.net;
  if (!net || !pane.entries.some(e => e.name === name && e.kind === 'file')) throw new Error('请选择远端普通文件。');
  const remote = path.posix.join(pane.dir, name);
  if (await net.realpath(remote) !== remote) throw new Error('远端文件已改变，请刷新。');
  const stat = await net.stat(remote);
  if (!isFile(stat.mode)) throw new Error('请选择远端普通文件。');
  limited(stat.size);
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-sftp-edit-')));
  // Only the extension is carried into the private temporary directory. The selected editor is
  // launched directly (never ShellExecute/openPath on the downloaded document).
  const ext = path.posix.extname(name).match(/^\.[a-z0-9]{1,12}$/i)?.[0] || '.txt';
  const file = path.join(dir, 'document' + ext);
  try {
    const handle = await fs.open(file, 'wx', 0o600);
    try { await net.download(remote, handle, limited, check); }
    finally { await handle.close(); }
    const original = await withLocal(file, reader => digestStream(reader, check));
    const initialStamp = await draftStamp({file});
    check();
    await launch(file);
    check();
    return { net, dir, file, remote, original, name, initialStamp };
  } catch (error) { await fs.rm(dir, { recursive: true, force: true }); throw error; }
}

async function saveDraft(draft, check) {
  const { net, remote, file, original } = draft;
  const parent = path.posix.dirname(remote);
  const nonce = randomUUID();
  const next = path.posix.join(parent, '.brclio-edit-' + nonce + '.tmp');
  const backup = path.posix.join(parent, '.brclio-original-' + nonce);
  let staged = false, moved = false;
  try {
    const attrs = await net.stat(remote);
    if (!isFile(attrs.mode) || await net.realpath(remote) !== remote) throw new Error('远端文件已改变，编辑副本已保留。');
    const hash = await withLocal(file, source => digestStream(source, check));
    if (hash === original) return false;
    await withLocal(file, reader => net.withFile(next, true, async writer => {
      staged = true;
      await copyBytes(reader, writer, limited, check);
    }));
    // Verify the upload and reject changes made while the editor was saving.
    if (await net.withFile(next, false, input => digestStream(input, check)) !== hash) throw new Error('编辑副本正在变化，请保存后重试。');
    const stagingAttrs = await net.stat(next);
    if (attrs.mode & 0o7000 || attrs.uid !== stagingAttrs.uid || attrs.gid !== stagingAttrs.gid) {
      throw new Error('目标的文件归属或特殊权限无法保留，请使用远端编辑器。');
    }
    if ((stagingAttrs.mode & 0o777) !== (attrs.mode & 0o777)) await net.chmod(next, attrs.mode & 0o777);
    if (await net.withFile(remote, false, input => digestStream(input, check)) !== original) {
      throw new Error('远端文件已被其他程序修改，编辑副本已保留。');
    }
    check();
    await net.rename(remote, backup);
    moved = true;
    const movedAttrs = await net.stat(backup);
    if (movedAttrs.mode !== attrs.mode || movedAttrs.uid !== attrs.uid || movedAttrs.gid !== attrs.gid ||
        await net.withFile(backup, false, input => digestStream(input, check)) !== original) {
      throw new Error('远端文件已被其他程序修改，编辑副本已保留。');
    }
    check();
    // Standard SFTP v3 rename refuses to replace a concurrent writer's new file.
    await net.rename(next, remote);
    staged = false;
    moved = false;
    try { await net.remove(backup); }
    catch { throw new Error('文件已更新，旧版本保留在 ' + backup); }
    return true;
  } catch (error) {
    if (moved) {
      try { await net.rename(backup, remote); }
      catch { throw new Error('无法还原远端原文件，已保存在 ' + backup + '。' + error.message); }
    }
    throw error;
  } finally {
    if (staged) await net.remove(next).catch(() => {});
  }
}

async function draftStamp(draft) {
  const info = await fs.lstat(draft.file, { bigint: true });
  if (!info.isFile()) throw new Error('本地编辑副本已移动。');
  return [info.ino, info.size, info.mtimeNs, info.ctimeNs].join('/');
}

const discard = draft => fs.rm(draft.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });

async function launchEditor(file, application) {
  const mac = process.platform === 'darwin';
  const exe = mac ? '/usr/bin/open' : application || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'notepad.exe');
  const args = mac ? ['-a', application || '/System/Applications/TextEdit.app', file] : [file];
  await new Promise((resolve, reject) => {
    const child = spawn(exe, args, { stdio: 'ignore', detached: true, shell: false });
    child.once('error', reject);
    if (mac) child.once('exit', code => code === 0 ? resolve() : reject(new Error('编辑器未能打开文件。')));
    else child.once('spawn', resolve);
    child.unref();
  });
}
module.exports = { openDraft, saveDraft, discard, launchEditor, draftStamp };
