'use strict';

(() => {
  const library = typeof module === 'object' ? require('./connection.js') : window.BrclioConnection;
  const limit = 1024 * 1024;

  function csvRows(text) {
    const rows = [];
    let row = [], field = '', quoted = false, closed = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c !== '"') field += c;
        else if (text[i + 1] === '"') { field += '"'; i++; }
        else { quoted = false; closed = true; }
      } else if (c === ',') {
        row.push(field.trim()); field = ''; closed = false;
      } else if (c === '\r' || c === '\n') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field.trim());
        if (row.some(Boolean)) rows.push(row);
        row = []; field = ''; closed = false;
      } else if (c === '"' && !field && !closed) quoted = true;
      else if (closed || c === '"') throw new Error('CSV 引号格式无效。');
      else field += c;
      if (rows.length > 2049 || row.length > 128) throw new Error('导入表格过大。');
    }
    if (quoted) throw new Error('CSV 缺少结束引号。');
    row.push(field.trim());
    if (row.some(Boolean)) rows.push(row);
    return rows;
  }

  function csv(text, add, warn) {
    const [header, ...rows] = csvRows(text);
    const keys = (header || []).map(s => s.toLowerCase().replace(/[ _-]/g, ''));
    if (!keys.some(k => ['host','hostname','address','ip','ipaddress'].includes(k))) throw new Error('CSV 需要 hostname 或 address 列。');
    function get(row, ...names) {
      for (const name of names) {
        const value = row[keys.indexOf(name)];
        if (value) return value;
      }
      return '';
    }
    rows.forEach((row, index) => {
      const protocol = get(row, 'protocol').toLowerCase();
      if (protocol && !['ssh','sftp','ssh2'].includes(protocol)) { warn('第 ' + (index + 2) + ' 行不是 SSH 主机'); return; }
      const host = get(row, 'hostname', 'host', 'address','ipaddress','ip');
      const tags = get(row,'tags').split(/[,;，]/).map(s => s.trim()).filter(Boolean);
      add({ host, name: get(row,'label','name','alias') || host, port: get(row,'port','sshport'),
        user: get(row,'username','user','login'), group: [get(row,'group','groups'),get(row,'subgroup')].filter(Boolean).join('/'), tags }, index + 2);
    });
  }

  function glob(pattern, name) {
    // Match SSH's hostname wildcards with bounded work, without compiling input as a regex.
    let p = 0, n = 0, star = -1, restart = 0;
    while (n < name.length) {
      if (pattern[p] === '?' || pattern[p] === name[n]) { p++; n++; }
      else if (pattern[p] === '*') { star = p++; restart = n; }
      else if (star >= 0) { p = star + 1; n = ++restart; }
      else return false;
    }
    while (pattern[p] === '*') p++;
    return p === pattern.length;
  }

  function config(text, add, warn) {
    const blocks = [{ patterns:['*'], options:new Map() }], aliases = new Map();
    let block = blocks[0], comparisons = 0;
    const fields = new Map([['hostname','host'],['user','user'],['port','port'],['proxyjump','jump'],['identityfile','identityFile'],['certificatefile','certificateFile']]);
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      const match = /^\s*([\w]+)(?:\s*=\s*|\s+)(.*)$/.exec(line);
      if (!match) continue;
      const key = match[1].toLowerCase(), value = match[2].replace(/(?:^|\s+)#.*$/, '').trim();
      if (key === 'host') {
        const patterns = value.toLowerCase().split(/\s+/);
        if (patterns.length > 128 || patterns.some(p => p.length > 255) || blocks.length >= 2048) throw new Error('SSH 配置超过导入上限。');
        block = { patterns, options:new Map() };
        blocks.push(block);
        for (const alias of value.split(/\s+/)) if (alias && !/[!*?]/.test(alias)) aliases.set(alias.toLowerCase(), alias);
      } else if (key === 'match') {
        block = null; warn('已略过 Match 条件段');
      } else if (key === 'include' || key === 'proxycommand') {
        warn('已略过 ' + key + ' 指令');
      } else if (block && fields.has(key) && !block.options.has(fields.get(key))) {
        block.options.set(fields.get(key), value.replace(/^"([^"]*)"$/, '$1'));
      } else if (block && key === 'forwardagent' && !block.options.has('agentForwarding')) {
        block.options.set('agentForwarding', value.toLowerCase() === 'yes');
      }
      if (aliases.size > 2048) throw new Error('一次最多导入 2048 台主机。');
    }
    for (const [key, name] of aliases) {
      const options = new Map();
      for (const {patterns, options: values} of blocks) {
        let matches = false, excluded = false;
        for (const pattern of patterns) {
          comparisons += (key.length + 1) * pattern.length;
          if (comparisons > 48_000_000) throw new Error('SSH 通配配置过于复杂，请分文件导入。');
          if (pattern.startsWith('!')) { if (glob(pattern.slice(1), key)) { excluded = true; break; } }
          else if (glob(pattern, key)) matches = true;
        }
        if (matches && !excluded) for (const [field, value] of values) if (!options.has(field)) options.set(field, value);
      }
      const record = { name, host:name, ...Object.fromEntries(options) };
      if (record.jump?.toLowerCase() === 'none') delete record.jump;
      for (const field of ['certificateFile','identityFile']) if (record[field]?.toLowerCase() === 'none') delete record[field];
      record.host = record.host.replace(/%h/g, name);
      add(record, name);
    }
  }

  function putty(text, add, warn) {
    let session;
    function finish() {
      if (!session?.host) return;
      if (session.protocol && session.protocol !== 'ssh') { warn('已略过非 SSH 会话'); return; }
      add(session, session.name);
    }
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith('[')) {
        finish(); session = null;
        const match = /^\[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\([^\\\]]+)\]$/i.exec(line);
        if (match) {
          let name;
          try { name = decodeURIComponent(match[1]); } catch { warn('已略过无法解码的 PuTTY 会话名称'); continue; }
          if (name !== 'Default Settings') session = { name };
        }
      } else if (session) {
        if (line.startsWith('"PublicKeyFile"=')) warn('PuTTY 身份文件需在导入后单独关联。');
        const value = /^"(HostName|UserName|Protocol)"="((?:\\.|[^"\\])*)"$/.exec(line);
        if (value) session[{HostName:'host',UserName:'user',Protocol:'protocol'}[value[1]]] = value[2].replace(/\\(["\\])/g, '$1');
        const port = /^"PortNumber"=dword:([\da-f]{8})$/i.exec(line);
        if (port) session.port = parseInt(port[1],16);
      }
    }
    finish();
  }

  function parse(format, text, fileName) {
    if (typeof text !== 'string' || text.length > limit || text.includes('\0')) throw new Error('请选择 1 MiB 以内的文本配置文件。');
    const hosts = [], notices = new Set(), names = new Set();
    const qualified = new Set();
    let skipped = 0;
    const warn = message => { if (notices.size < 12) notices.add(message); };
    const add = (input, position) => {
      if (hosts.length + skipped >= 2048) throw new Error('一次最多导入 2048 台主机。');
      let item;
      try { item = library.named(input); }
      catch (error) { skipped++; warn(String(position).slice(0,64) + ' · ' + error.message); return; }
      if (format === 'securecrt' || format === 'mobaxterm') {
        const identity = JSON.stringify([item.group || '', item.name]);
        if (qualified.has(identity)) { skipped++; warn('文件内的重名会话已略过'); return; }
        qualified.add(identity);
        if (names.has(item.name)) {
          const base = (item.name + ' · ' + (item.group || '根目录')).slice(0, 58);
          item.name = base;
          for (let i = 2; names.has(item.name); i++) item.name = base + ' (' + i + ')';
        }
      } else if (names.has(item.name)) { skipped++; warn('文件内的重名主机已略过'); return; }
      names.add(item.name); hosts.push(item);
    };
    const sessions = typeof module === 'object' ? require('./host-import-sessions.js') : window.BrclioSessionImport;
    const ansible = typeof module === 'object' ? require('./host-import-ansible.js') : window.BrclioAnsibleImport;
    const readers = new Map([['ansible',ansible],['csv',csv],['openssh',config],['putty',putty],['securecrt',sessions.securecrt],['mobaxterm',sessions.moba]]);
    if (!readers.has(format)) throw new Error('不支持的导入格式。');
    readers.get(format)(text.replace(/^\uFEFF/,''), add, warn, fileName);
    return { hosts, notices:[...notices], skipped };
  }
  const api = { parse, limit };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else window.BrclioHostImport = api;
})();
