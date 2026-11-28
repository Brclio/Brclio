'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const supported = ext => typeof ext === 'string' && (ext === '' || /^\.[a-z0-9]{1,12}$/i.test(ext));

function preferences(directory) {
  const file = directory ? path.join(directory,'brclio-sftp-editors-v1.json') : null;
  const memory = new Map();
  const validApp = item => typeof item === 'string' && path.isAbsolute(item) && item.length <= 4096 &&
    path.extname(item).toLowerCase() === (process.platform === 'win32' ? '.exe' : '.app');
  async function entries() {
    if (!file) return memory;
    try {
      const info = await fs.lstat(file);
      if (!info.isFile() || info.size > 256 * 1024) throw new Error('编辑器关联文件无效。');
      const record = JSON.parse(await fs.readFile(file,'utf8'));
      if (record.version !== 1 || !Array.isArray(record.editors) || record.editors.length > 128 ||
          record.editors.some(item => !supported(item?.extension) || !validApp(item.application))) throw new Error('编辑器关联格式无效。');
      return new Map(record.editors.map(item => [item.extension,item.application]));
    } catch (error) { if (error.code === 'ENOENT') return new Map(); throw error; }
  }
  const list = values => [...values].sort(([a],[b])=>a.localeCompare(b)).map(([extension,application])=>({extension,application}));
  return {
    async list() { return list(await entries()); },
    async get(ext) { return supported(ext) ? (await entries()).get(ext) : undefined; },
    async set(ext,application) {
      if (!supported(ext)) return;
      if (file && application && !validApp(application)) throw new Error('请选择编辑器应用。');
      const values=await entries();
      if (application) values.set(ext,application); else values.delete(ext);
      if (values.size > 128) throw new Error('请先移除不再使用的编辑器关联。');
      if (!file) return;
      const temporary=file+'.'+randomUUID()+'.tmp';
      try {
        await fs.mkdir(directory,{recursive:true,mode:0o700});
        await fs.writeFile(temporary,JSON.stringify({version:1,editors:list(values)}),{mode:0o600,flag:'wx'});
        await fs.rename(temporary,file);
      } finally { await fs.rm(temporary,{force:true}); }
    },
  };
}
module.exports={preferences};
