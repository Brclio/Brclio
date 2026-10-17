import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';

// Download the original linked in resources/README.md, then pass its local path.
// Keep the 38.7 MiB traced SVG out of the offline clients; render its full canvas.
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
if (!process.argv[2]) throw new Error('Usage: node scripts/generate-icons.mjs /path/to/brclio-logo.svg');
if (process.platform !== 'darwin') throw new Error('Generate the complete icon set on macOS (iconutil is required).');
const source = await readFile(path.resolve(process.argv[2]));
const sourceHash = createHash('sha256').update(source).digest('hex');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'brclio-icons-'));
const iconset = path.join(temporary, 'Brclio.iconset');
await mkdir(iconset);
const browser = await chromium.launch({
  executablePath: process.env.BRCLIO_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});

try {
  const page = await browser.newPage();
  await page.route('**/*', route => route.abort());
  const rendered = await page.evaluate(async svg => {
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    const image = new Image();
    image.src = url;
    await image.decode();
    if (image.naturalWidth !== image.naturalHeight) throw new Error('The source icon must be square.');
    const render = (size, inset = 0) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const context = canvas.getContext('2d');
      if (inset) {
        context.fillStyle = '#FDFBF5';
        context.fillRect(0, 0, size, size);
      }
      context.drawImage(image, inset, inset, size - inset * 2, size - inset * 2);
      return canvas.toDataURL('image/png').split(',')[1];
    };
    const pngs = Object.fromEntries([16, 24, 32, 48, 64, 72, 96, 128, 144, 192, 256, 512, 1024].map(size => [size, render(size)]));
    // Android adaptive foregrounds use a 108 dp canvas with a 66 dp safe zone.
    // Fit the source into the middle 71 dp, retaining its own margin and allowing
    // for antialiased pixels at the boundary of circular launcher masks.
    pngs.adaptive = render(432, 74);
    URL.revokeObjectURL(url);
    return pngs;
  }, source.toString('utf8'));
  const pngs = Object.fromEntries(Object.entries(rendered).map(([size, data]) => [size, Buffer.from(data, 'base64')]));
  const save = async (relative, data) => {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
  };
  await save('resources/icon.png', pngs[1024]);
  await save('web/assets/icon.png', pngs[256]);

  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, index) => {
    const entry = 6 + index * 16;
    header[entry] = header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(pngs[size].length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += pngs[size].length;
  });
  await save('resources/icon.ico', Buffer.concat([header, ...sizes.map(size => pngs[size])]));
  for (const size of [16, 32, 128, 256, 512]) {
    await writeFile(path.join(iconset, `icon_${size}x${size}.png`), pngs[size]);
    await writeFile(path.join(iconset, `icon_${size}x${size}@2x.png`), pngs[size * 2]);
  }
  await promisify(execFile)('iconutil', ['-c', 'icns', iconset, '-o', path.join(root, 'resources/icon.icns')]);

  const android = 'android/app/src/main/res';
  for (const [density, size] of Object.entries({ mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 })) {
    await save(`${android}/mipmap-${density}/ic_brclio.png`, pngs[size]);
  }
  await save(`${android}/drawable-nodpi/ic_brclio_foreground.png`, pngs.adaptive);
  console.log(`Generated macOS, Windows, Android and web icons. Source SHA-256: ${sourceHash}`);
} finally {
  await browser.close();
  await rm(temporary, { recursive: true, force: true });
}
