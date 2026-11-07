'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { defaultRun } = require('../desktop/mac-installer-helper.cjs');
const { checkMacBrclioProcesses } = require('./mac-client-helper.cjs');

// An accessory application with no windows, a random identity and a deliberately
// delayed graceful exit. This runs only on macOS and never queries the real client.
test('native AppKit quits only the original fixture, observes its exit and preserves a late duplicate', {
  skip: process.platform !== 'darwin', timeout: 60000,
}, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-native-process-')));
  const id = 'org.example.brclio-fixture.' + randomUUID();
  const target = path.join(root, 'canonical', 'Fixture.app'), other = path.join(root, 'legacy', 'Fixture.app');
  const children = [];
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exit = once(child, 'exit');
      child.kill('SIGKILL');
      await exit;
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  const source = path.join(root, 'fixture.m');
  await fs.writeFile(source, `#import <AppKit/AppKit.h>
@interface Delegate : NSObject<NSApplicationDelegate>
@end
@implementation Delegate
- (void)applicationDidFinishLaunching:(NSNotification *)note {
  puts("ready"); fflush(stdout);
}
- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)app {
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 800 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
    [app replyToApplicationShouldTerminate:YES];
  });
  return NSTerminateLater;
}
@end
int main(void) { @autoreleasepool {
  NSApplication *app = [NSApplication sharedApplication];
  Delegate *delegate = [Delegate new];
  [app setActivationPolicy:NSApplicationActivationPolicyAccessory];
  [app setDelegate:delegate]; [app run]; return 0;
} }`);
  const contents = path.join(target, 'Contents');
  await fs.mkdir(path.join(contents, 'MacOS'), { recursive: true });
  await fs.writeFile(path.join(contents, 'Info.plist'), `<?xml version="1.0"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleExecutable</key><string>Fixture</string>
<key>CFBundleName</key><string>Fixture</string><key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string><key>LSUIElement</key><true/>
</dict></plist>`);
  await defaultRun('/usr/bin/clang', ['-fobjc-arc', '-framework', 'AppKit', source, '-o', path.join(contents, 'MacOS', 'Fixture')]);
  await defaultRun('/usr/bin/codesign', ['--force', '-s', '-', target]);
  await fs.cp(target, other, { recursive: true });

  async function start(bundle) {
    const child = spawn(path.join(bundle, 'Contents', 'MacOS', 'Fixture'), [], { stdio: ['ignore', 'pipe', 'inherit'] });
    children.push(child);
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', () => reject(new Error('fixture exited before becoming ready')));
      child.stdout.once('data', chunk => chunk.toString().includes('ready') ? resolve() : reject(new Error('invalid fixture startup')));
    });
    return child;
  }
  async function nativeRun(program, args, opts) {
    assert.equal(args[4], 'com.brclio.toolbox');
    const fixtureArgs = args.slice(); fixtureArgs[4] = id;
    return defaultRun(program, fixtureArgs, opts);
  }
  async function checkWith(hook) {
    const actions = [];
    await checkMacBrclioProcesses(target, async (program, args, opts) => {
      actions.push(args.at(-1));
      const state = await nativeRun(program, args, opts);
      if (hook) await hook(args.at(-1), state);
      return state;
    }, true);
    return actions;
  }

  assert.deepEqual(await checkWith(), ['quit']);
  const first = await start(target);
  const exit = once(first, 'exit');
  const actions = await checkWith();
  assert.equal(actions[0], 'quit');
  assert.ok(actions.length > 1 && actions.slice(1).every(action => action === 'check'));
  assert.deepEqual(await exit, [0, null]);

  const canonical = await start(target);
  const originalExit = once(canonical, 'exit');
  let duplicate;
  const conflict = err => err.message.includes(other);
  await assert.rejects(checkWith(async action => {
    if (action === 'quit') duplicate = await start(other);
  }), conflict);
  assert.deepEqual(await originalExit, [0, null]);
  assert.equal(duplicate.exitCode, null);

  const restarted = await start(target);
  await assert.rejects(checkWith(), conflict);
  assert.equal(restarted.exitCode, null);
  assert.equal(duplicate.exitCode, null);
});
