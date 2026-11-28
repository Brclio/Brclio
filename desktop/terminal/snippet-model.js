'use strict';

(() => {
  const key = 'brclio.terminal.snippets.v1';
  const placeholder = /\{\{([\p{L}_][\p{L}\p{N}_.-]{0,63})\}\}/gu;
  const invalidLabel = /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u;
  function variables(text) {
    const names = [...new Set(Array.from(text.matchAll(placeholder), match => match[1]))];
    if (names.length > 24) throw new Error('每个剪藏最多使用 24 个不同变量。');
    return names;
  }
  function fill(text, values) {
    const draft = text.replace(placeholder, (match, name) => values.has(name) ? values.get(name) : match);
    if (draft.length > 32768) throw new Error('填写后的剪藏超过 32768 个字符。');
    return draft;
  }
  function normalize(raw) {
    if (typeof raw?.id !== 'string' || !raw.id || raw.id.length > 256 || invalidLabel.test(raw.id) ||
        !['snippet','note'].includes(raw.kind) || typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 80 ||
        typeof raw.text !== 'string' || !raw.text || raw.text.length > 32768) throw new Error('无法读取剪藏或笔记条目。');
    const item = { id: raw.id, kind: raw.kind, name: raw.name.trim(), text: raw.text };
    if (raw.package) {
      if (typeof raw.package !== 'string' || raw.package.length > 64 || invalidLabel.test(raw.package)) throw new Error('剪藏包名称最多为 64 个可显示字符。');
      if (raw.package.trim()) item.package = raw.package.trim();
    }
    if (item.kind === 'snippet' && raw.template === true) { variables(item.text); item.template = true; }
    return item;
  }
  function read(storage) {
    const raw = JSON.parse(storage.getItem(key) || '[]');
    if (!Array.isArray(raw) || raw.length > 200) throw new Error('无法读取已保存的剪藏与笔记。');
    const entries = raw.map(normalize);
    if (new Set(entries.map(item => item.id)).size !== entries.length) throw new Error('剪藏与笔记含重复标识。');
    return entries;
  }
  function search(items, query, packageName) {
    const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    return items.filter(item => {
      if (packageName != null && (item.package || '') !== packageName) return false;
      const haystack = [item.name, item.package || '', item.text].join(' ').toLowerCase();
      return words.every(word => haystack.includes(word));
    });
  }
  const label = item => [item.package, item.name].filter(Boolean).join(' / ');
  const api = { key, read, normalize, fill, variables, search, label };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else window.BrclioSnippetModel = api;
})();
