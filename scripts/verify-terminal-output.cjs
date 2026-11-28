'use strict';

const assert = require('node:assert/strict');

async function verifyTerminalOutput(page) {
  // Use a disposable emulator in the real terminal document so that the
  // packaged scripts, CSP and renderer are exercised without sending replies
  // to the running shell or changing its cursor, buffer or selection.
  const result = await page.evaluate(async () => {
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:-2000px;top:0;width:640px;height:240px';
    document.body.append(host);
    const terminal = new Terminal({ cols: 50, rows: 10, allowProposedApi: true });
    try {
      terminal.open(host);
      const images = BrclioTerminalOutput.activate(terminal);
      const write = data => new Promise(resolve => terminal.write(data, resolve));
      const pixel = row => {
        const image = images.getImageAtBufferCell(0, row);
        return image && Array.from(image.getContext('2d').getImageData(0, 0, 1, 1).data);
      };
      await write('🦊');
      const foxWidth = terminal.buffer.active.getLine(0).getCell(0).getWidth();

      const canvas = document.createElement('canvas');
      canvas.width = 8; canvas.height = 6;
      const brush = canvas.getContext('2d');
      brush.fillStyle = 'rgb(7, 91, 201)';
      brush.fillRect(0, 0, 8, 6);
      const png = canvas.toDataURL('image/png').split(',')[1];
      const iip = '\x1b]1337;File=inline=1;width=8px;height=6px;size=';
      await write('\x1b[2;1H' + iip + atob(png).length + ':' + png + '\x07');
      await write('\x1b[4;1H\x1bPq"1;1;8;6#1;2;100;0;0#1!8~\x1b\\');

      const usage = images.storageUsage;
      await write('\x1b[6;1H' + iip + '8388609:' + png + '\x07' + 'after-limit');
      return {
        unicode: terminal.unicode.activeVersion, foxWidth, png: pixel(1), sixel: pixel(3),
        oversized: Boolean(pixel(5)), stayedWithinLimit: images.storageUsage === usage && usage > 0 && usage <= 48,
        remainingText: terminal.buffer.active.getLine(5).translateToString(true),
      };
    } finally {
      terminal.dispose();
      host.remove();
    }
  });
  assert.deepEqual(result, {
    unicode: '11', foxWidth: 2, png: [7, 91, 201, 255], sixel: [255, 0, 0, 255],
    oversized: false, stayedWithinLimit: true, remainingText: 'after-limit',
  });
}

async function verifyShellImages(page, command, windows) {
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 12; canvas.height = 12;
    const brush = canvas.getContext('2d');
    brush.fillStyle = 'rgb(7, 91, 201)';
    brush.fillRect(0, 0, 12, 12);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  const data = '\x1b[2J\x1b[H\x1b]1337;File=inline=1;width=12px;height=12px;size=' +
    Buffer.from(png, 'base64').length + ':' + png + '\x07\r\n' +
    '\x1bPq"1;1;12;6#1;2;100;0;0#1!12~\x1b\\\r\n';
  const encoded = Buffer.from(data).toString('base64');
  await command(windows
    ? "[Console]::Write([Text.Encoding]::ASCII.GetString([Convert]::FromBase64String('" + encoded + "')))"
    : "printf '%s' '" + encoded + "' | /usr/bin/base64 -D");
  await page.waitForFunction(() => {
    const canvas = document.querySelector('.panel:not([hidden]) .pane.active .xterm-image-layer');
    if (!canvas) return false;
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let iip = false, sixel = false;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] !== 255) continue;
      if (pixels[i] === 7 && pixels[i + 1] === 91 && pixels[i + 2] === 201) iip = true;
      if (pixels[i] === 255 && pixels[i + 1] === 0 && pixels[i + 2] === 0) sixel = true;
      if (iip && sixel) return true;
    }
    return false;
  }, null, { timeout: 12000, polling: 200 });
}

module.exports = { verifyTerminalOutput, verifyShellImages };
