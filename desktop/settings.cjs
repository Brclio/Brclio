'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { normalizeSettings } = require('../core/path-engine.cjs');

/** One atomic, serialized store shared by the window and context-menu launches. */
function createSettingsStore(directory) {
  const filename = path.join(directory, 'settings.json');
  let pending = Promise.resolve();
  async function read() {
    await pending;
    try {
      return normalizeSettings(JSON.parse(await fs.readFile(filename, 'utf8')));
    } catch (error) {
      if (error.code === 'ENOENT') return normalizeSettings({});
      if (error instanceof SyntaxError) {
        // Preserve a damaged file for recovery rather than silently overwriting it.
        await fs.copyFile(filename, `${filename}.corrupt-${Date.now()}`);
        return normalizeSettings({});
      }
      throw error;
    }
  }
  function write(input) {
    const settings = normalizeSettings(input);
    const operation = pending.then(async () => {
      await fs.mkdir(directory, { recursive: true });
      const temporary = `${filename}.${process.pid}.tmp`;
      try {
        await fs.writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
        await fs.rename(temporary, filename);
      } finally {
        await fs.rm(temporary, { force: true });
      }
      return settings;
    });
    pending = operation.catch(() => {});
    return operation;
  }
  return { read, write, filename };
}

module.exports = { createSettingsStore };
