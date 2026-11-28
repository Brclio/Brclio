'use strict';

// SFTP v3 packets are length-prefixed binary data on an SSH subsystem.
// Paths and file bytes never enter a shell or the interactive sftp language.
const FX = {
  init: 1, version: 2, open: 3, close: 4, read: 5, write: 6, lstat: 7, fstat: 8, setstat: 9,
  opendir: 11, readdir: 12, remove: 13, mkdir: 14, rmdir: 15, realpath: 16, rename: 18,
  status: 101, handle: 102, data: 103, name: 104, attrs: 105,
};
const MAX_PACKET = 4 * 1024 * 1024;
const BLOCK = 32 * 1024;
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
const str = value => {
  const b = Buffer.from(value);
  return Buffer.concat([u32(b.length), b]);
};

function reader(bytes) {
  let offset = 0;
  function take(size) {
    if (offset + size > bytes.length) throw new Error('SFTP 响应不完整。');
    const result = bytes.subarray(offset, offset + size);
    offset += size;
    return result;
  }
  const uint32 = () => take(4).readUInt32BE();
  const string = () => take(uint32());
  function attrs() {
    const flags = uint32();
    const result = {};
    if (flags & 1) result.size = Number(take(8).readBigUInt64BE());
    if (flags & 2) { result.uid = uint32(); result.gid = uint32(); }
    if (flags & 4) result.mode = uint32();
    if (flags & 8) { uint32(); result.mtime = uint32(); }
    if (flags & 0x80000000) {
      const count = uint32();
      for (let i = 0; i < count; i++) { string(); string(); }
    }
    return result;
  }
  return { uint32, string, attrs };
}

function connectProtocol(child, terminate = () => child.kill()) {
  let buffer = Buffer.alloc(0);
  let nextId = 0;
  let closed = false;
  let stderr = '';
  const requests = new Map();
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const initTimer = setTimeout(() => stop(new Error('SSH 身份验证超时。')), 180000);
  function stop(reason = new Error('SFTP 连接已关闭。')) {
    if (closed) return;
    closed = true;
    clearTimeout(initTimer);
    rejectReady(reason);
    for (const req of requests.values()) {
      clearTimeout(req.timer);
      req.reject(reason);
    }
    requests.clear();
    terminate();
  }
  function write(type, parts) {
    const payload = Buffer.concat([Buffer.from([type]), ...parts]);
    child.stdin.write(Buffer.concat([u32(payload.length), payload]));
  }
  function receive(packet) {
    const type = packet[0];
    const data = reader(packet.subarray(1));
    if (type === FX.version) {
      if (data.uint32() !== 3) throw new Error('服务端未协商 SFTP v3。');
      clearTimeout(initTimer);
      resolveReady();
      return;
    }
    const id = data.uint32();
    const request = requests.get(id);
    if (!request) throw new Error('SFTP 响应序号无效。');
    requests.delete(id);
    clearTimeout(request.timer);
    request.resolve({type, data});
  }
  child.stdout.on('data', chunk => {
    try {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE();
        if (length < 5 || length > MAX_PACKET) throw new Error('SFTP 返回了无效的数据包。');
        if (buffer.length < length + 4) break;
        const packet = buffer.subarray(4, length + 4);
        buffer = buffer.subarray(length + 4);
        receive(packet);
      }
    } catch (error) { stop(error); }
  });
  child.stderr.on('data', part => { stderr = (stderr + part.toString()).slice(-2048); });
  child.on('error', stop);
  child.stdin.on('error', stop);
  child.on('close', () => stop(new Error(stderr.trim() || 'SSH 连接已关闭。')));
  write(FX.init, [u32(3)]);

  async function request(type, expected, parts, eof = false) {
    if (closed) throw new Error('SFTP 连接已关闭，请重新连接。');
    const id = ++nextId;
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => stop(new Error('SFTP 服务器响应超时。')), 45000);
      requests.set(id, { resolve, reject, timer });
      write(type, [u32(id), ...parts]);
    });
    if (result.type === FX.status) {
      const code = result.data.uint32();
      if (eof && code === 1) return null;
      if (code !== 0) {
        const message = result.data.string().toString();
        const error = new Error(message || ('SFTP 错误 ' + code));
        error.sftpCode = code;
        throw error;
      }
    }
    if (result.type !== expected) throw new Error('SFTP 返回了意外的响应类型。');
    return result.data;
  }
  function names(data) {
    const result = [];
    const count = data.uint32();
    for (let i = 0; i < count; i++) {
      const bytes = data.string();
      data.string(); // The server's legacy longname is for human display only.
      const attrs = data.attrs();
      const name = bytes.toString();
      if (!Buffer.from(name).equals(bytes)) continue; // Cannot address it losslessly with a JS path.
      result.push({ name, ...attrs });
    }
    return result;
  }
  const closeHandle = handle => request(FX.close, FX.status, [str(handle)]);
  async function withHandle(type, fields, fn) {
    const handle = (await request(type, FX.handle, fields)).string();
    let completed = false;
    try {
      const value = await fn(handle);
      completed = true;
      return value;
    } finally {
      // Preserve the original IO failure if closing the same connection also fails.
      const closing = closeHandle(handle);
      if (completed) await closing; else await closing.catch(() => {});
    }
  }
  async function withFile(p, writing, fn) {
    const fields = writing ? [str(p), u32(2 | 8 | 32), u32(4), u32(0o600)] : [str(p), u32(1), u32(0)];
    return withHandle(FX.open, fields, async handle => {
      let offset = 0;
      if (!writing) {
        const attrs = (await request(FX.fstat, FX.attrs, [str(handle)])).attrs();
        if ((attrs.mode & 0o170000) !== 0o100000) throw new Error('请选择普通文件。');
      }
      return fn({
        async read(buffer) {
          const length = Math.min(buffer.length, BLOCK);
          const response = await request(FX.read, FX.data, [str(handle), u64(offset), u32(length)], true);
          if (!response) return { bytesRead: 0 };
          const data = response.string();
          if (!data.length || data.length > length) throw new Error('SFTP 文件分块无效。');
          data.copy(buffer);
          offset += data.length;
          return { bytesRead: data.length };
        },
        async write(buffer, start, length) {
          await request(FX.write, FX.status, [str(handle), u64(offset), str(buffer.subarray(start, start + length))]);
          offset += length;
          return { bytesWritten: length };
        },
      });
    });
  }
  return {
    ready, stop,
    async realpath(path) {
      const [entry] = names(await request(FX.realpath, FX.name, [str(path)]));
      if (!entry) throw new Error('无法读取远端路径。');
      return entry.name;
    },
    async list(path) {
      return withHandle(FX.opendir, [str(path)], async handle => {
        const entries = [];
        for (;;) {
          const data = await request(FX.readdir, FX.name, [str(handle)], true);
          if (!data) return entries;
          const batch = names(data);
          if (!batch.length || entries.length + batch.length > 50000) throw new Error('远端目录过大或列表无效。');
          entries.push(...batch);
        }
      });
    },
    withFile,
    upload: (remote, local, progress, assertActive) => withFile(remote, true,
      sink => copyBytes(local, sink, progress, assertActive)),
    download: (remote, local, progress, assertActive) => withFile(remote, false,
      source => copyBytes(source, local, progress, assertActive)),
    stat: async p => (await request(FX.lstat, FX.attrs, [str(p)])).attrs(),
    chmod: (p, mode) => request(FX.setstat, FX.status, [str(p), u32(4), u32(mode)]),
    mkdir: p => request(FX.mkdir, FX.status, [str(p), u32(0)]),
    remove: (p, directory = false) => request(directory ? FX.rmdir : FX.remove, FX.status, [str(p)]),
    rename: (from, to) => request(FX.rename, FX.status, [str(from), str(to)]),
  };
}

async function copyBytes(source, sink, progress, assertActive) {
  const buffer = Buffer.alloc(BLOCK);
  let total = 0;
  for (;;) {
    assertActive();
    const { bytesRead } = await source.read(buffer);
    if (!bytesRead) return total;
    let written = 0;
    while (written < bytesRead) {
      assertActive();
      const { bytesWritten } = await sink.write(buffer, written, bytesRead - written);
      if (!bytesWritten) throw new Error('无法写入目标文件。');
      written += bytesWritten;
    }
    total += bytesRead;
    progress(total);
  }
}
module.exports = { connectProtocol, copyBytes };
