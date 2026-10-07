import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') throw new Error('Native Finder tests require macOS and Xcode command-line tools.');
const source = path.dirname(fileURLToPath(import.meta.url));
const temporary = mkdtempSync(path.join(os.tmpdir(), 'brclio-finder-tests-'));
try {
  const executable = path.join(temporary, 'finder-tests');
  execFileSync('xcrun', ['--sdk', 'macosx', 'swiftc', '-swift-version', '5', '-module-name', 'BrclioFinderSync',
    '-parse-as-library', '-framework', 'FinderSync', '-framework', 'AppKit', '-framework', 'Foundation',
    path.join(source, 'FinderSync.swift'), path.join(source, 'FinderSyncTests.swift'), '-o', executable], { stdio: 'inherit' });
  // This process never instantiates the extension, registers with Finder,
  // launches Brclio, reads selected files, or touches the clipboard.
  execFileSync(executable, [], { stdio: 'inherit' });
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
