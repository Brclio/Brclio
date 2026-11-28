'use strict';

(() => {
  function history() {
    const paths = [];
    let cursor = -1;

    function target(step) {
      if (step !== -1 && step !== 1) return null;
      return paths[cursor + step] ?? null;
    }

    function visit(path, step = 0) {
      if (step && target(step) !== null) {
        cursor += step;
        paths[cursor] = path;
      } else if (paths[cursor] !== path) {
        paths.splice(cursor + 1, paths.length, path);
        if (paths.length > 64) paths.shift();
        cursor = paths.length - 1;
      }
    }
    return { target, visit };
  }

  const folded = name => name.normalize('NFC').toLowerCase();
  function filter(entries, query, showHidden) {
    const text = folded(query);
    return entries.filter(item => (showHidden || !item.name.startsWith('.')) &&
      (!text || folded(item.name).includes(text)));
  }

  const clock = new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'medium' });
  function properties(entry) {
    const modified = Number.isInteger(entry?.mtime) && entry.mtime >= 0 && entry.mtime <= 0xffffffff ?
      clock.format(new Date(entry.mtime * 1000)) : '';
    const mode = Number.isInteger(entry?.mode) && entry.mode >= 0 && entry.mode <= 0xffffffff ?
      (entry.mode & 0o7777).toString(8).padStart(4, '0') : '';
    return { modified, mode };
  }

  const api = { history, filter, properties };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else window.BrclioSftpNavigation = api;
})();
