import { copyFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = path.join(root, `web/path-engine.${process.pid}.tmp`);
await copyFile(path.join(root, 'core/path-engine.cjs'), temporary);
await rename(temporary, path.join(root, 'web/path-engine.js'));
const parserTemporary = path.join(root, `web/xhs/lib/xhs-parser.${process.pid}.tmp`);
await copyFile(path.join(root, 'desktop/xhs/lib/xhs.js'), parserTemporary);
await rename(parserTemporary, path.join(root, 'web/xhs/lib/xhs-parser.js'));
// Android Gradle syncWebAssets owns its generated assets directory.
console.log('已同步共享路径引擎与小红书解析器。Android 资源由 Gradle 同步。');
