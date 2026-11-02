const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getEventListeners } = require('node:events');

test('Live Photo preflight cancellation does not wait for WebCodecs capability promises', async t => {
  const { planLivePhoto, checkLivePhotoSupport, selectLivePhotoVideoConfig } = await import('../web/xhs/lib/live-photo-maker.js');
  const names = ['VideoEncoder', 'VideoFrame', 'AudioEncoder', 'AudioData', 'AudioContext', 'MediaRecorder', 'document'];
  const previous = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  t.after(() => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  const set = (name, value) => Object.defineProperty(globalThis, name, { configurable: true, value });
  for (const name of ['VideoFrame', 'AudioData', 'AudioContext']) set(name, class {});
  set('MediaRecorder', { isTypeSupported: () => true });
  set('document', { createElement: () => ({ width: 0, height: 0,
    getContext: () => ({ fillRect() {}, getImageData: () => ({ data: [255, 255, 255, 255] }) }) }) });
  const files = [{ name: 'local.png', type: 'image/png', size: 10, arrayBuffer: async () => new ArrayBuffer(10) }];
  const info = { kind: 'images', duration: null, width: 64, height: 64, images: [{ width: 64, height: 64 }], hasAudio: false };

  for (const stage of ['initial video support', 'initial audio support', 'selected video dimensions']) {
    await t.test(stage, { timeout: 3000 }, async () => {
      let enter, rejectProbe, calls = 0;
      const entered = new Promise(resolve => { enter = resolve; });
      const pendingProbe = () => { calls++; enter(); return new Promise((_resolve, reject) => { rejectProbe = reject; }); };
      set('VideoEncoder', { isConfigSupported: config =>
        stage === 'initial video support' || (stage === 'selected video dimensions' && config.width === 64)
          ? pendingProbe() : Promise.resolve({ supported: true, config }) });
      set('AudioEncoder', { isConfigSupported: config => stage === 'initial audio support'
        ? pendingProbe() : Promise.resolve({ supported: true, config }) });
      const controller = new AbortController(), reason = new DOMException('User cancelled preflight', 'AbortError');
      const pending = planLivePhoto(files, { includeAudio: false }, { info, signal: controller.signal });
      const rejected = assert.rejects(pending, error => error === reason);
      await entered;
      assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
      controller.abort(reason);
      let deadline;
      try {
        await Promise.race([rejected, new Promise((_resolve, reject) => {
          deadline = setTimeout(() => reject(new Error('Cancellation waited for the unresolved codec probe')), 1000);
        })]);
      } finally { clearTimeout(deadline); }
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      assert.equal(calls, 1, 'Cancelling must not continue into fallback probes.');
      // The rejected vendor promise settles after our consumer has stopped.
      // node:test also fails the test if this creates an unhandled rejection.
      rejectProbe(new Error('Late codec rejection'));
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(calls, 1);
    });
  }

  await t.test('successful probes and already-aborted calls leave no listeners or unnecessary work', async () => {
    let calls = 0;
    const supported = async config => { calls++; return { supported: true, config }; };
    set('VideoEncoder', { isConfigSupported: supported }); set('AudioEncoder', { isConfigSupported: supported });
    const controller = new AbortController();
    await planLivePhoto(files, {}, { info, signal: controller.signal });
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    const previousCalls = calls;
    controller.abort();
    await assert.rejects(checkLivePhotoSupport({ signal: controller.signal }), { name: 'AbortError' });
    await assert.rejects(selectLivePhotoVideoConfig({ width: 64, height: 64 }, { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(calls, previousCalls);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });
});
