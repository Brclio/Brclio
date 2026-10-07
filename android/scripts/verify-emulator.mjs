import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Run on an explicitly selected disposable emulator; never targets a physical device by default.
const device = process.argv[2] || 'emulator-5582';
assert.match(device, /^emulator-\d+$/, 'Pass an emulator serial, not a physical device.');
const adbPath = process.env.BRCLIO_ADB_PATH || 'adb';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const appPackage = 'com.brclio.toolbox.debug';
const activity = `${appPackage}/com.brclio.toolbox.MainActivity`;
const reportDir = resolve(root, 'android/app/build/reports/emulator');
const port = 19228;
const checks = [];
const pause = milliseconds => new Promise(resolveWait => setTimeout(resolveWait, milliseconds));

function adb(...args) {
  const result = spawnSync(adbPath, ['-s', device, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'adb failed');
  return result.stdout.trim();
}

async function until(check, label, timeout = 15000) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeout) {
    try { if (await check()) return; } catch (error) { lastError = error; }
    await pause(200);
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ''}`);
}

async function connect() {
  let pid;
  await until(() => { pid = adb('shell', 'pidof', appPackage); return /^\d+$/.test(pid); }, 'App process');
  adb('forward', `tcp:${port}`, `localabstract:webview_devtools_remote_${pid}`);
  let page;
  await until(async () => {
    const pages = await fetch(`http://127.0.0.1:${port}/json`).then(response => response.json());
    page = pages.find(item => item.url.includes('/assets/web/index.html'));
    return Boolean(page?.webSocketDebuggerUrl);
  }, 'Bundled WebView');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolveOpen, reject) => {
    socket.addEventListener('open', resolveOpen, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  const errors = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
  });
  const send = (method, params = {}) => new Promise((resolveCall, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }, 15000);
    pending.set(id, { resolve: resolveCall, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await send('Runtime.enable');
  const evaluate = async expression => {
    const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result.value;
  };
  await until(async () => await evaluate("document.body.dataset.ready === 'true'"), 'UI initialization');
  return { evaluate, errors, close: () => socket.close() };
}

mkdirSync(reportDir, { recursive: true });
adb('install', '-r', resolve(root, 'android/app/build/outputs/apk/debug/app-debug.apk'));
adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
adb('shell', 'wm', 'dismiss-keyguard');
adb('shell', 'am', 'force-stop', appPackage);
adb('shell', 'am', 'start', '-W', '-n', activity);
let client = await connect();

try {
  const platform = await client.evaluate('window.BrclioHost.getPlatform()');
  assert.equal(platform.platform, 'android');
  assert.equal(platform.capabilities.filePicker, true);
  assert.equal(platform.capabilities.systemIntegration, false);
  assert.equal(await client.evaluate('location.origin'), 'https://appassets.androidplatform.net');
  assert.equal(await client.evaluate("document.querySelector('#platform-label').textContent"), 'Android 客户端');
  assert.equal(await client.evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  checks.push('offline WebView, native bridge, Android capabilities, responsive width');

  const clipboardText = '/storage/emulated/0/Documents/产品 说明.md';
  await client.evaluate(`window.BrclioHost.copyText(${JSON.stringify(clipboardText)})`);
  await client.evaluate("document.querySelector('#manual-paths').value='';document.querySelector('#manual-paths').focus();true");
  adb('shell', 'input', 'keyevent', '279');
  await until(async () => await client.evaluate("document.querySelector('#manual-paths').value") === clipboardText, 'Native clipboard paste');
  checks.push('native clipboard write and Android paste round trip with Chinese/spaces');

  for (const kind of ['file', 'directory', 'base']) {
    await client.evaluate(`window.__pickerResult='pending';window.BrclioHost.pickPaths({kind:${JSON.stringify(kind)}}).then(value=>window.__pickerResult=value);true`);
    await until(() => /com.google.android.documentsui|com.android.documentsui/.test(adb('shell', 'dumpsys', 'activity', 'activities')), `SAF ${kind} picker`);
    adb('shell', 'input', 'keyevent', '4');
    await until(async () => Array.isArray(await client.evaluate('window.__pickerResult')), `SAF ${kind} cancellation`);
    assert.deepEqual(await client.evaluate('window.__pickerResult'), []);
  }
  checks.push('real system file/directory/base pickers and cancellation callbacks');

  const settings = {
    pathMode: 'relative', basePath: '/storage/emulated/0/Documents/trailing ',
    quoteMode: 'double', separator: 'forward', trailingSlash: true,
    joinWith: 'comma', launchAtLogin: false,
  };
  assert.deepEqual(await client.evaluate(`window.BrclioHost.saveSettings({ ...${JSON.stringify(settings)} })`), settings);
  client.close();
  adb('shell', 'am', 'force-stop', appPackage);
  adb('shell', 'am', 'start', '-W', '-n', activity);
  client = await connect();
  assert.deepEqual(await client.evaluate('window.BrclioHost.getSettings()'), settings);
  checks.push('native settings persist across process restart, preserving trailing spaces');

  const defaults = await client.evaluate('window.BrclioPath.DEFAULT_SETTINGS');
  await client.evaluate(`window.BrclioHost.saveSettings(${JSON.stringify(defaults)})`);
  await client.evaluate('location.reload();true');
  await until(async () => await client.evaluate("document.body.dataset.ready === 'true'"), 'Reload after settings reset');

  const sharedUri = 'content://com.example.cloud/documents/plan%20draft.pdf';
  adb('shell', 'am', 'start', '-W', '-n', activity, '-a', 'android.intent.action.VIEW', '-d', sharedUri, '-t', 'application/pdf');
  await until(async () => await client.evaluate("document.querySelector('#manual-paths').value") === sharedUri, 'URI share dispatch');
  assert.equal(await client.evaluate("document.querySelector('#path-preview').textContent"), sharedUri);
  assert.match(await client.evaluate("document.querySelector('#preview-footnote').textContent"), /URI/);
  checks.push('incoming content URI stays unchanged and visibly labeled');

  await client.evaluate("document.querySelector('#clear-paths').click();true");
  adb('shell', 'input', 'keyevent', '4');
  // Back may close the app after dismissing the keyboard; reopen for the final screenshot.
  adb('shell', 'am', 'start', '-W', '-n', activity);
  await pause(400);
  const screenshot = spawnSync(adbPath, ['-s', device, 'exec-out', 'screencap', '-p']);
  assert.equal(screenshot.status, 0);
  writeFileSync(resolve(reportDir, 'android.png'), screenshot.stdout);
  assert.deepEqual(client.errors, []);
  writeFileSync(resolve(reportDir, 'verification.json'), JSON.stringify({
    device, checkedAt: new Date().toISOString(), platform, checks,
    limitation: 'Emulator validation. Real devices, third-party share permission grants, and OEM file managers remain separate acceptance checks.',
  }, null, 2) + '\n');
  console.log(JSON.stringify({ passed: checks.length, checks, screenshot: resolve(reportDir, 'android.png') }, null, 2));
} finally {
  client.close();
  adb('forward', '--remove', `tcp:${port}`);
}
