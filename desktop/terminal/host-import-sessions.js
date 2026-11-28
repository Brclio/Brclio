'use strict';

(() => {
  function moba(text, add, warn, fileName) {
    const single = typeof fileName === 'string' && /\.moba$/i.test(fileName) && /^[^=\r\n]+=\s*#-?\d+#/.test(text.trim());
    let folder = single ? '' : null, recognized = single;
    let records = [];
    function finish() {
      for (const [name, fields] of records) {
        const [protocol, host, port, login] = fields;
        if (protocol !== '0') { warn('已略过非 SSH 书签'); continue; }
        const user = !login || login.toLowerCase() === '<default>' ? '' : login;
        add({ name, host, port: port || 22, user, group: folder }, name);
      }
      records = [];
    }
    for (const source of text.split(/\r?\n/)) {
      const line = source.trim();
      if (line.startsWith('[')) {
        finish();
        folder = /^\[Bookmarks(?:_\d+)?\]$/i.test(line) ? '' : null;
        if (folder !== null) recognized = true;
        continue;
      }
      if (folder === null) continue;
      const equal = line.indexOf('=');
      if (equal < 1) continue;
      const name = line.slice(0,equal).trim(), value = line.slice(equal+1).trim();
      if (name === 'SubRep') { folder = value.replaceAll('\\','/'); continue; }
      if (name === 'ImgNum') continue;
      const match = /^#-?\d+#([^#]+)(?:#|$)/.exec(value);
      if (!match) { warn('已略过无法识别的书签'); continue; }
      if (records.length >= 2048) throw new Error('一次最多导入 2048 台主机。');
      records.push([name, match[1].split('%',4)]);
    }
    finish();
    if (!recognized) throw new Error('未找到明文 MobaXterm Bookmarks 节。请选择导出的 .mxtsessions 或配置 INI 文件。');
  }

  function addSecure(fields, name, group, add, warn) {
    if (!fields.has('Hostname')) return;
    const protocol = fields.get('Protocol Name');
    if (protocol && !['ssh2', 'ssh', 'sftp'].includes(protocol.toLowerCase())) { warn('已略过非 SSH 会话'); return; }
    if (!name || name === 'Default' && !group) { warn('已略过默认会话模板'); return; }
    add({ host: fields.get('Hostname'), user: fields.get('Username') || '', port: fields.get('[SSH2] Port') || null, name, group }, name);
  }

  function secureIni(text, add, warn, fileName) {
    const fields = new Map();
    for (const line of text.split(/\r?\n/)) {
      const value = /^S:"(Hostname|Username|Protocol Name)"=(.*)$/.exec(line);
      const port = /^D:"\[SSH2\] Port"=([a-f0-9]{8})$/i.exec(line);
      if (value) fields.set(value[1], value[2].trim());
      if (port) fields.set('[SSH2] Port', String(parseInt(port[1], 16)));
    }
    if (!fields.has('Hostname')) throw new Error('未找到可读取的 SecureCRT 会话，请选择设置 XML 或单个 SSH 会话 INI。');
    const name = (typeof fileName === 'string' && fileName.split(/[\\/]/).pop().replace(/\.ini$/i, '')) || fields.get('Hostname');
    addSecure(fields, name, '', add, warn);
  }

  function secureXml(text, add, warn) {
    if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text)) throw new Error('不支持含 DTD 或实体声明的设置 XML。');
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const root = doc.documentElement;
    if (doc.getElementsByTagName('parsererror').length || root.tagName !== 'VanDyke') throw new Error('不是有效的 SecureCRT 设置 XML。');
    const subkeys = (key, name) => Array.from(key.children).filter(child => child.tagName === 'key' && (!name || child.getAttribute('name') === name));
    const sections = [...subkeys(root, 'Sessions'), ...subkeys(root, 'Config').flatMap(key => subkeys(key, 'Sessions'))];
    if (!sections.length) throw new Error('XML 中没有明文 Sessions 节，请导出可读取的会话设置。');
    let count = 0;
    function visit(key, folders) {
      if (++count > 32768 || folders.length > 64) throw new Error('SecureCRT 分组过多或过深。');
      const name = key.getAttribute('name');
      if (!name) return;
      const fields = new Map();
      for (const child of key.children) {
        const field = child.getAttribute('name');
        if (child.childElementCount) continue;
        if ((child.tagName === 'string' && ['Hostname','Username','Protocol Name'].includes(field)) ||
            (child.tagName === 'dword' && field === '[SSH2] Port')) fields.set(field, child.textContent.trim());
      }
      if (fields.has('Hostname')) {
        addSecure(fields, name, folders.join('/'), add, warn);
      } else {
        const next = folders.concat(name);
        for (const child of subkeys(key)) visit(child, next);
      }
    }
    for (const section of sections) for (const key of subkeys(section)) visit(key, []);
  }

  function securecrt(text, add, warn, fileName) {
    if (text.trimStart().startsWith('<')) secureXml(text, add, warn);
    else secureIni(text, add, warn, fileName);
  }

  const api = { moba, securecrt };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else window.BrclioSessionImport = api;
})();
