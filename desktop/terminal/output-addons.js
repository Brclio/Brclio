(() => {
  'use strict';

  function activate(terminal) {
    terminal.loadAddon(new Unicode11Addon.Unicode11Addon());
    terminal.unicode.activeVersion = '11';

    const images = new ImageAddon.ImageAddon({
      // Limits apply to each pane. The storage limit counts decoded pixels in MB.
      pixelLimit: 8 * 1024 * 1024,
      iipSizeLimit: 8 * 1024 * 1024,
      sixelSizeLimit: 8 * 1024 * 1024,
      storageLimit: 48,
    });
    terminal.loadAddon(images);
    return images;
  }

  window.BrclioTerminalOutput = Object.freeze({ activate });
})();
