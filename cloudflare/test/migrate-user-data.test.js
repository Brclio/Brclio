import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('private GitHub migration safety and byte-preservation scenarios', () => {
  const result = spawnSync('python3', [fileURLToPath(new URL('./test_migrate_user_data.py', import.meta.url))], {
    encoding: 'utf8', timeout: 30000,
    env: {...process.env, GITHUB_INSTALLATION_TOKEN: '', SOURCE_GITHUB_INSTALLATION_TOKEN: '', PYTHONDONTWRITEBYTECODE: '1'}
  });
  assert.equal(result.status, 0, result.stdout + result.stderr + (result.error?.message || ''));
});
