/* Together with the native desktop logger, expose only fixed diagnostic events. */
(() => {
  'use strict';
  const host = window.BrclioHost;
  if (!host) return;
  if (!window.brclio) {
    const prefix = 'brclio.diagnostics.v1.';
    const retention = 7 * 86400000;
    const limit = 256;
    const actions = new Set(['app.start', 'ui.error', 'live.import', 'live.generate', 'live.export',
      'account.request', 'paths.pick', 'clipboard.write', 'settings.save', 'integration.set',
      'update.check', 'update.download', 'update.install', 'xhs.parse', 'xhs.request']);
    function days() {
      const cutoff = new Date(Date.now() - retention).toISOString().slice(0, 10);
      return Object.keys(localStorage).filter(key => key.startsWith(prefix)).filter(key => {
        if (key.slice(prefix.length) >= cutoff) return true;
        localStorage.removeItem(key);
        return false;
      }).sort();
    }
    function load(key) {
      try {
        const rows = JSON.parse(localStorage.getItem(key));
        return Array.isArray(rows) ? rows.filter(row => row && actions.has(row.action)
          && ['INFO', 'ERROR', 'WARN'].includes(row.level) && typeof row.time === 'string'
          && Date.parse(row.time) >= Date.now() - retention && Date.parse(row.time) <= Date.now())
          .slice(-limit).map(({time, level, action}) => ({time: new Date(time).toISOString(), level, action, fields: {}})) : [];
      } catch { return []; }
    }
    function record(action, outcome = 'ok') {
      if (!actions.has(action) || !['ok','error','cancel'].includes(outcome)) return;
      try {
        days();
        const time = new Date().toISOString(), key = prefix + time.slice(0, 10);
        const rows = load(key);
        rows.push({time, level: outcome === 'error' ? 'ERROR' : outcome === 'cancel' ? 'WARN' : 'INFO', action});
        localStorage.setItem(key, JSON.stringify(rows.slice(-limit)));
      } catch { /* Logging must not interrupt the user's action. */ }
    }
    const wrap = (name, operation) => {
      const original = host[name];
      if (typeof original !== 'function') return;
      host[name] = async (...args) => {
        const action = name === 'xhsRequest' && args[0] === 'parse' ? 'xhs.parse' : operation;
        try {
          const result = await original(...args);
          record(action, result?.ok === false ? 'error' : result?.cancelled ? 'cancel' : 'ok');
          return result;
        } catch (error) { record(action, 'error'); throw error; }
      };
    };
    for (const [name, action] of Object.entries({accountRequest:'account.request', pickPaths:'paths.pick',
      copyText:'clipboard.write', saveSettings:'settings.save', setIntegration:'integration.set', checkForUpdates:'update.check',
      downloadUpdate:'update.download', installUpdate:'update.install', xhsRequest:'xhs.request'})) wrap(name, action);
    host.recordSoftwareEvent = record;
    host.getSoftwareLogs = async () => {
      const logs = days().flatMap(load).slice(-1792);
      return {days: 7, entryCount: logs.length, logs, text: logs.map(row => [row.time, row.level, row.action].join('  ')).join('\n')};
    };
    record('app.start');
  }
  function record(action, outcome) {
    try { Promise.resolve(host.recordSoftwareEvent?.(action, outcome)).catch(() => {}); } catch {}
  }
  window.addEventListener('error', () => record('ui.error', 'error'));
  window.addEventListener('unhandledrejection', () => record('ui.error', 'error'));
})();
