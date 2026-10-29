import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { ProfileManager } from "../desktop/profile-manager.js";
import { downloadMedia, safeFilename } from "../desktop/media-download.js";
import { mp4Fixture } from './fixtures/mp4.js';

// Adapted from the downloader regression suite; account gates are intentionally absent.
export async function run(t) {

const PROFILE = "https://www.xiaohongshu.com/user/profile/5e413a430000000001000f4c";
const A = "111111111111111111111111";
const B = "222222222222222222222222";
const note = (id = A) => ({ id, url: `https://www.xiaohongshu.com/explore/${id}`, title: `标题 ${id}` });
const imageUrl = (key = "image") => `https://ci.xiaohongshu.com/${key}?imageView2/format/jpg`;
const videoUrl = (key = "video") => `https://sns-video-bd.xhscdn.com/stream/${key}.mp4`;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 4, 5, 6, 0xff, 0xd9]);
const MP4 = mp4Fixture();
function noteFolder(fixture, id = A) {
  return path.join(fixture.directory, fixture.manager.snapshot().items.find(item => item.id === id)?.directoryName || id);
}
function parsed(overrides = {}) {
  return { title: "测试标题：/路径", content: "第一行\n第二行", strategy: "exact-initial-state", images: [{ url: imageUrl() }], videos: [], ...overrides };
}
function mediaResponse(url) {
  const video = String(url).includes(".mp4");
  const body = video ? MP4 : JPEG;
  return new Response(body, { headers: { "content-type": video ? "video/mp4" : "image/jpeg", "content-length": String(body.length) } });
}
async function fixture(t, options = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "xhs-profile-test-")));
  const directory = path.join(base, "downloads");
  const stateDirectory = path.join(base, "state");
  await fs.mkdir(directory);
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  let clock = 100000;
  const requests = [];
  const waits = [];
  const browser = options.browser || {
    async *discover() { yield { notes: [note()], done: true }; },
    async resolveNote(item) { requests.push({ type: "note", id: item.id, at: clock }); return parsed(); }
  };
  const fetchImpl = options.fetchImpl || (async (url, options) => {
    requests.push({ type: "media", url, at: clock, redirect: options.redirect });
    return mediaResponse(url);
  });
  const config = {
    stateDirectory, browser, fetchImpl, authorize: async () => ({ authorized: true }), now: () => clock, random: () => 0.5,
    sleep: async (ms, signal) => { signal?.throwIfAborted(); waits.push(ms); clock += ms; },
    ...options
  };
  const manager = new ProfileManager(config);
  await manager.initialize();
  const start = async (extra = {}) => manager.start({ profileUrl: PROFILE, directory, intervalSeconds: 3, jitterSeconds: 3, ...extra });
  const settle = async () => { await manager._runTask; return manager.snapshot(); };
  return { base, directory, stateDirectory, requests, waits, manager, config, start, settle };
}

await t.test('clearing XHS login waits for active parsing to abort and preserves saved files and queue progress', async t => {
  let parsingStarted, aborted = false;
  const parsing = new Promise(resolve => { parsingStarted = resolve; });
  const f = await fixture(t);
  f.manager.browser.discover = async function* () { yield { notes: [note(A), note(B)], done: true }; };
  f.manager.browser.resolveNote = async (item, { signal }) => {
    if (item.id === A) return parsed();
    parsingStarted();
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
      aborted = true; reject(Object.assign(Error('paused'), { name: 'AbortError' }));
    }, { once: true }));
  };
  f.manager.browser.clearLoginData = async () => {
    assert.equal(aborted, true);
    assert.equal(f.manager.snapshot().status, 'paused');
    return { status: 'logged-out', loggedIn: false, nickname: '', userId: '' };
  };
  await f.start();
  await parsing;
  const downloaded = path.join(noteFolder(f, A), 'image-001.jpg');
  const original = await fs.readFile(downloaded);
  const { loginState, profileState } = await f.manager.clearLoginData();
  assert.equal(loginState.status, 'logged-out');
  assert.equal(profileState.status, 'paused');
  assert.equal(profileState.completed, 1);
  assert.equal(profileState.items.find(item => item.id === B).status, 'pending');
  assert.deepEqual(await fs.readFile(downloaded), original);
  const restored = new ProfileManager(f.config);
  await restored.initialize();
  assert.equal(restored.snapshot().completed, 1);
  assert.equal(restored.snapshot().discovered, 2);
});

await t.test("profile queue deduplicates notes and saves images, paired live MP4, default video and metadata sequentially", async (t) => {
  const f = await fixture(t);
  f.manager.browser = {
    async *discover() {
      yield { notes: [note(A), note(A)], done: false, profileName: "作者" };
      yield { notes: [note(B)], done: true };
    },
    async resolveNote(item) {
      f.requests.push({ type: "note", at: f.manager.now(), id: item.id });
      return parsed({
        images: [{ url: imageUrl(item.id), livePhoto: true, liveVideo: { url: videoUrl("live") } }],
        videos: [{ url: videoUrl("low") }, { url: videoUrl("high"), isDefault: true }]
      });
    }
  };
  await f.start();
  const result = await f.settle();
  assert.equal(result.status, "completed");
  assert.equal(result.discoveryComplete, true);
  assert.equal(result.discovered, 2);
  assert.equal(result.completed, 2);
  assert.equal(result.failed, 0);
  assert.equal(result.profileName, "作者");
  const names = await fs.readdir(noteFolder(f, A));
  assert.deepEqual(names.sort(), [".xhs-download.json", "image-001.jpg", "live-001.mp4", "video.mp4", "笔记.json", "笔记.txt"].sort());
  assert.match(await fs.readFile(path.join(noteFolder(f, A), "笔记.txt"), "utf8"), /^\uFEFF小红书笔记/);
  assert.match(await fs.readFile(path.join(noteFolder(f, A), "笔记.txt"), "utf8"), /第一行\n第二行/);
  assert.equal(f.requests.some((item) => item.url === videoUrl("low")), false);
  for (let index = 1; index < f.requests.length; index++) assert.ok(f.requests[index].at - f.requests[index - 1].at >= 4500);
  assert.ok(f.requests.filter((item) => item.type === "media").every((item) => item.redirect === "manual"));
});

await t.test('profile videos prefer declared original sources without calling an account service', async t => {
  const original = 'https://sns-video-bd.xhscdn.com/original.mp4';
  const features = [];
  const f = await fixture(t, { authorize: async feature => { features.push(feature); return { authorized: true }; } });
  f.manager.browser.resolveNote = async () => parsed({ images: [],
    videos: [{ url: videoUrl('playback'), isDefault: true }], originalVideos: [{ url: original, hasAudio: true }] });
  await f.start();
  assert.equal((await f.settle()).completed, 1);
  assert.equal(f.requests.some(request => request.url === original), true);
  assert.equal(f.requests.some(request => request.url === videoUrl('playback')), false);
  assert.equal(features.length, 0);
  const manifest = JSON.parse(await fs.readFile(path.join(noteFolder(f), '.xhs-download.json'), 'utf8'));
  assert.equal(manifest.files.find(file => file.key === 'video').watermarkFree, true);
});

await t.test("restart performs no network and skips only files whose size and SHA-256 both verify", async (t) => {
  const f = await fixture(t);
  await f.start();
  await f.settle();
  f.requests.length = 0;
  const restored = new ProfileManager(f.config);
  assert.equal((await restored.initialize()).status, "completed");
  assert.equal(f.requests.length, 0);
  await restored.resume();
  await restored._runTask;
  assert.equal(restored.snapshot().skipped, 1);
  assert.equal(f.requests.length, 0);
  const imagePath = path.join(noteFolder(f, A), "image-001.jpg");
  await fs.writeFile(imagePath, Buffer.alloc(JPEG.length, 42));
  await restored.resume();
  await restored._runTask;
  assert.equal(restored.snapshot().completed, 1);
  assert.deepEqual(await fs.readFile(imagePath), JPEG);
  assert.equal(f.requests.filter((item) => item.type === "media").length, 1);
});

await t.test("incomplete discovery saves confirmed notes before pausing; resume merges and verifies saved files", async (t) => {
  let run = 0;
  const f = await fixture(t, { browser: {
    async *discover() { run++; yield { notes: [note(A)], done: run > 1 }; },
    async resolveNote() { return parsed(); }
  } });
  await f.start();
  let result = await f.settle();
  assert.equal(result.status, "paused");
  assert.equal(result.discoveryComplete, false);
  assert.equal(result.discovered, 1);
  assert.equal(result.completed, 1);
  assert.equal(result.pauseReason, "DISCOVERY_INCOMPLETE");
  assert.equal(result.phase, "discovery");
  assert.match(result.discoveryIssue, /尚未确认加载到底/);
  assert.match(result.message, /已处理当前发现的 1 篇帖子.*补全列表/);
  const restored = new ProfileManager(f.config);
  assert.equal((await restored.initialize()).status, "paused");
  assert.equal(run, 1);
  await restored.resume();
  await restored._runTask;
  result = restored.snapshot();
  assert.equal(result.status, "completed");
  assert.equal(result.discoveryComplete, true);
  assert.equal(result.discovered, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.pauseReason, "");
  assert.equal(result.discoveryIssue, "");
});

await t.test("a stalled list still downloads every confirmed queued note and keeps discovery resumable", async (t) => {
  const resolved = [], updates = [];
  const f = await fixture(t, { onUpdate: state => updates.push(state), browser: {
    async *discover() {
      yield { notes: [note(A), note(B)], done: false };
      throw Object.assign(new Error("列表连续多次没有加载新帖子。"), { code: "DISCOVERY_INCOMPLETE" });
    },
    async resolveNote(item) { resolved.push(item.id); return parsed(); }
  } });
  await f.start();
  const result = await f.settle();
  assert.deepEqual(resolved, [A, B]);
  assert.equal(result.completed, 2);
  assert.equal(result.status, "paused");
  assert.equal(result.discoveryComplete, false);
  assert.equal(result.pauseReason, "DISCOVERY_INCOMPLETE");
  assert.ok(updates.some(state => state.completed === 2 && state.status === "discovering"));
  assert.equal(result.discoveryIssue, "列表连续多次没有加载新帖子。");
  const saved = JSON.parse(await fs.readFile(path.join(f.stateDirectory, "profile-job.json"), "utf8"));
  assert.equal(saved.discoveryComplete, false);
  assert.equal(saved.discoveryIssue, result.discoveryIssue);
  assert.ok(saved.items.every(item => item.complete && item.status === "completed"));
});

await t.test("a later discovery gate preserves saved pages but never downloads remaining old queue entries", async (t) => {
  for (const code of ["AUTH_REQUIRED", "RATE_LIMITED", "INVALID_NOTE", "AbortError"]) {
    let resolved = 0;
    const f = await fixture(t, { browser: {
      async *discover() {
        yield { notes: [note(A)], done: false };
        throw Object.assign(new Error("discovery interrupted"), code === "AbortError" ? { name: code } : { code });
      },
      async resolveNote() { resolved++; return parsed(); }
    } });
    f.manager.state.profileUrl = PROFILE;
    f.manager.state.directory = f.directory;
    f.manager.state.items = [{ ...note(B), sequence: 1, directoryName: "", titleResolved: false, status: "pending", error: "", complete: false, files: [] }];
    await f.manager.resume();
    const result = await f.settle();
    assert.equal(resolved, 1, code);
    assert.equal(result.completed, 1, code);
    assert.equal(result.items.find(item => item.id === B).status, "pending", code);
    assert.equal(result.discoveryComplete, false, code);
  }
});

await t.test("each confirmed page is saved before requesting the next page, including a later 151st note", async (t) => {
  const ids = Array.from({ length: 151 }, (_, index) => (index + 1).toString(16).padStart(24, "0"));
  const resolved = [], updates = [];
  const f = await fixture(t, { onUpdate: state => updates.push(state), browser: {
    async *discover() {
      yield { notes: ids.slice(0, 3).map(id => note(id)), done: false };
      assert.deepEqual(resolved, ids.slice(0, 3), "the first page saves before a terminal marker exists");
      assert.equal(f.manager.snapshot().discoveryComplete, false);
      assert.equal(f.manager.snapshot().phase, "discovery");
      yield { notes: ids.slice(0, 121).map(id => note(id)), done: false };
      assert.deepEqual(resolved, ids.slice(0, 121));
      yield { notes: ids.slice(120).map(id => note(id)), done: true };
    },
    async resolveNote(item) { resolved.push(item.id); return parsed({ title: `已解析-${item.id}` }); }
  } });
  await f.start();
  const result = await f.settle();
  assert.deepEqual(resolved, ids, "duplicates on later pages are neither re-downloaded nor recounted as skipped");
  assert.equal(result.discovered, 151);
  assert.equal(result.completed, 151);
  assert.equal(result.skipped, 0);
  assert.equal(result.status, "completed");
  assert.equal(result.discoveryComplete, true);
  assert.deepEqual(result.items.map(item => item.sequence), ids.map((_, index) => index + 1));
  assert.ok(updates.some(state => state.completed === 3 && !state.discoveryComplete));
  assert.ok(updates.every(state => state.status !== "completed" || state.discoveryComplete));
});

await t.test("a detail login or verification gate stops the page and prevents later pagination", async (t) => {
  for (const code of ["AUTH_REQUIRED", "RATE_LIMITED", "DISCOVERY_INCOMPLETE"]) {
    const resolved = []; let nextPage = false;
    const f = await fixture(t, { browser: {
      async *discover() {
        yield { notes: [note(A), note(B)], done: false };
        nextPage = true;
        yield { notes: [], done: true };
      },
      async resolveNote(item) {
        resolved.push(item.id);
        throw Object.assign(new Error("详情访问需要验证"), { code });
      }
    } });
    await f.start();
    const result = await f.settle();
    assert.deepEqual(resolved, [A], code);
    assert.equal(nextPage, false, code);
    assert.equal(result.status, "paused", code);
    assert.equal(result.pauseReason, code);
    assert.equal(result.completed, 0);
    assert.ok(result.items.every(item => item.status === "pending"));
  }
});

await t.test("profile access gates observed during a streamed page prevent the next detail or media request", async (t) => {
  for (const code of ["AUTH_REQUIRED", "RATE_LIMITED"]) {
    for (const stage of ["before-wait", "during-wait"]) {
      let blocked = false, waits = 0, resolved = 0, media = 0, nextPage = false;
      const f = await fixture(t, { browser: {
        async *discover() {
          yield { notes: [note(A), note(B)], done: false };
          nextPage = true;
          yield { notes: [], done: true };
        },
        assertDiscoveryAccess() {
          if (blocked) throw Object.assign(new Error("主页当前需要登录或验证"), { code });
        },
        async resolveNote() {
          resolved++;
          if (stage === "before-wait") blocked = true;
          return parsed();
        }
      },
      sleep: async (_ms, signal) => {
        signal?.throwIfAborted();
        if (++waits === 2 && stage === "during-wait") blocked = true;
      },
      fetchImpl: async url => { media++; return mediaResponse(url); }
      });
      await f.start(); const result = await f.settle();
      assert.equal(resolved, 1, `${code}/${stage}`);
      assert.equal(media, 0, `${code}/${stage}: no media fetch after access gate`);
      assert.equal(nextPage, false);
      assert.equal(result.status, "paused");
      assert.equal(result.pauseReason, code);
      assert.ok(result.items.every(item => item.status === "pending"));
    }
  }
});

await t.test("resuming an incomplete paged scan verifies saved notes, keeps sequence and merges new pages", async (t) => {
  const C = "333333333333333333333333";
  let round = 0; const resolved = [];
  const f = await fixture(t, { browser: {
    async *discover() {
      round++;
      yield { notes: [note(A)], done: false };
      if (round === 1) throw Object.assign(new Error("主页分页暂时中断"), { code: "DISCOVERY_INCOMPLETE" });
      yield { notes: [note(B), note(A)], done: false };
      yield { notes: [note(A), note(C)], done: true };
    },
    async resolveNote(item) { resolved.push(item.id); return parsed({ title: `完整-${item.id}` }); }
  } });
  await f.start(); await f.settle();
  const directoryName = f.manager.snapshot().items[0].directoryName;
  const restored = new ProfileManager(f.config);
  await restored.initialize();
  assert.equal(restored.snapshot().discoveryIssue, "主页分页暂时中断");
  await restored.resume(); await restored._runTask;
  const result = restored.snapshot();
  assert.deepEqual(resolved, [A, B, C]);
  assert.equal(result.skipped, 1);
  assert.equal(result.completed, 2);
  assert.equal(result.discoveryIssue, "");
  assert.deepEqual(result.items.map(item => item.id), [A, B, C]);
  assert.deepEqual(result.items.map(item => item.sequence), [1, 2, 3]);
  assert.equal(result.items[0].directoryName, directoryName);
});

await t.test("an incomplete empty list remains paused instead of reporting a completed empty profile", async (t) => {
  const f = await fixture(t, { browser: {
    async *discover() { yield { notes: [], done: false }; },
    async resolveNote() { throw new Error("must not resolve an empty list"); }
  } });
  await f.start();
  const result = await f.settle();
  assert.equal(result.status, "paused");
  assert.equal(result.pauseReason, "DISCOVERY_INCOMPLETE");
  assert.equal(result.discovered, 0);
});

await t.test("pause aborts detail parsing, flushes pending state, and resumes successfully", async (t) => {
  let began;
  const started = new Promise((resolve) => { began = resolve; });
  let block = true, nextPages = 0, closedScans = 0;
  const f = await fixture(t, { browser: {
    async *discover() {
      try {
        yield { notes: [note()], done: false };
        nextPages++;
        yield { notes: [], done: true };
      } finally { closedScans++; }
    },
    async resolveNote(_note, { signal }) {
      if (!block) return parsed();
      began();
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("abort"), { name: "AbortError" })), { once: true }));
    }
  } });
  await f.start();
  await started;
  await f.manager.pause();
  assert.equal(f.manager.snapshot().status, "paused");
  const state = JSON.parse(await fs.readFile(path.join(f.stateDirectory, "profile-job.json"), "utf8"));
  assert.equal(state.items[0].status, "pending");
  assert.equal(state.status, "paused");
  assert.equal(state.discoveryComplete, false);
  assert.equal(nextPages, 0, "pausing a streamed page must not trigger its next page");
  assert.equal(closedScans, 1, "the suspended discovery generator is closed on pause");
  block = false;
  await f.manager.resume();
  assert.equal((await f.settle()).completed, 1);
  assert.equal(nextPages, 1);
  assert.equal(closedScans, 2);
});

await t.test("cancel interrupts scheduled requests and preserves the resumable queue", async (t) => {
  let began;
  const started = new Promise((resolve) => { began = resolve; });
  const f = await fixture(t, { sleep: (_ms, signal) => {
    began();
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("abort"), { name: "AbortError" })), { once: true }));
  } });
  await f.start();
  await started;
  await f.manager.cancel();
  assert.equal(f.manager.snapshot().status, "cancelled");
  assert.equal(f.manager.snapshot().discovered, 1);
  assert.equal(f.requests.length, 0);
});

await t.test("transient media failure retries at most three times, removes partials, and supports retry failed", async (t) => {
  let attempts = 0;
  let good = false;
  const f = await fixture(t, { fetchImpl: async (url) => {
    attempts++;
    if (good) return mediaResponse(url);
    let sent = false;
    return new Response(new ReadableStream({ pull(controller) {
      if (!sent) { sent = true; controller.enqueue(JPEG.subarray(0, 4)); }
      else controller.error(new Error("connection closed"));
    } }), { headers: { "content-type": "image/jpeg" } });
  } });
  await f.start();
  assert.equal((await f.settle()).failed, 1);
  assert.equal(attempts, 3);
  assert.deepEqual(await fs.readdir(noteFolder(f, A)), [".xhs-download.json"]);
  good = true;
  await f.manager.retryFailed();
  assert.equal((await f.settle()).completed, 1);
  assert.equal(attempts, 4);
});

await t.test("rate limiting pauses immediately without retries or a false completed item", async (t) => {
  let attempts = 0;
  const f = await fixture(t, { fetchImpl: async () => { attempts++; return new Response("too many", { status: 429 }); } });
  await f.start();
  const result = await f.settle();
  assert.equal(result.status, "paused");
  assert.equal(result.completed, 0);
  assert.equal(result.failed, 0);
  assert.equal(attempts, 1);
  assert.equal(result.items[0].status, "pending");
});

await t.test("video backup URLs are attempted with pacing when the selected stream fails", async (t) => {
  const f = await fixture(t);
  f.manager.browser.resolveNote = async () => parsed({ images: [], videos: [{ isDefault: true, url: videoUrl("broken"), backupUrls: [videoUrl("working")] }] });
  const urls = [];
  f.manager.fetchImpl = async (url) => {
    urls.push({ url, at: f.manager.now() });
    return url === videoUrl("broken") ? new Response("missing", { status: 404 }) : mediaResponse(url);
  };
  await f.start();
  assert.equal((await f.settle()).completed, 1);
  assert.deepEqual(urls.map(({ url }) => url), [videoUrl("broken"), videoUrl("working")]);
  assert.ok(urls[1].at - urls[0].at >= 4500);
});

await t.test('silent ordinary video is rejected and a different audio-bearing stream is saved', async (t) => {
  const events = [];
  const f = await fixture(t, { onDiagnostic: (event, fields) => events.push({ event, ...fields }) });
  f.manager.browser.resolveNote = async () => parsed({ images: [], videos: [
    { url: videoUrl('silent'), isDefault: true }, { url: videoUrl('audible'), hasAudio: true }
  ] });
  const urls = [];
  f.manager.fetchImpl = async url => {
    urls.push(url);
    const body = mp4Fixture({ audio: url === videoUrl('audible') });
    return new Response(body, { headers: { 'content-type': 'video/mp4', 'content-length': String(body.length) } });
  };
  await f.start();
  const result = await f.settle();
  assert.equal(result.completed, 1);
  assert.deepEqual(urls, [videoUrl('silent'), videoUrl('audible')]);
  assert.equal(f.manager.state.items[0].files.find(file => file.key === 'video').mediaTracks.hasAudio, true);
  assert.ok(events.some(e => e.code === 'VIDEO_AUDIO_MISSING'));
  assert.doesNotMatch(JSON.stringify(events), /https:|cookie|token/i);
});

await t.test('all-silent normal videos leave no successful media file while silent Live Photos remain valid', async (t) => {
  for (const live of [false, true]) {
    const f = await fixture(t);
    f.manager.browser.resolveNote = async () => live
      ? parsed({ images: [{ url: imageUrl(), livePhoto: true, liveVideo: { url: videoUrl() } }] })
      : parsed({ images: [], videos: [{ url: videoUrl() }] });
    f.manager.fetchImpl = async url => url.endsWith('.mp4')
      ? new Response(mp4Fixture({ audio: false }), { headers: { 'content-type': 'video/mp4' } }) : mediaResponse(url);
    await f.start();
    const result = await f.settle();
    assert.equal(result.completed, live ? 1 : 0);
    assert.equal(result.failed, live ? 0 : 1);
    if (!live) assert.deepEqual(await fs.readdir(noteFolder(f)), ['.xhs-download.json']);
  }
});

await t.test('resume repairs a legacy completed silent video even when its saved size and hash are valid', async (t) => {
  for (const replacementHasAudio of [true, false]) {
    const f = await fixture(t);
    f.manager.browser.resolveNote = async () => parsed({ images: [], videos: [{ url: videoUrl() }] });
    await f.start();
    assert.equal((await f.settle()).completed, 1);
    const item = f.manager.state.items[0];
    const original = { sequence: item.sequence, directoryName: item.directoryName };
    const saved = item.files.find(file => file.key === 'video');
    const silent = mp4Fixture({ audio: false });
    const filename = path.join(noteFolder(f), saved.name);
    await fs.writeFile(filename, silent);
    saved.bytes = silent.length;
    saved.sha256 = createHash('sha256').update(silent).digest('hex');
    delete saved.mediaTracks;
    await f.manager._writeManifest(noteFolder(f), item);
    await f.manager._save();
    let requests = 0;
    const restored = new ProfileManager({ ...f.config, fetchImpl: async () => {
      requests++;
      return new Response(mp4Fixture({ audio: replacementHasAudio }), { headers: { 'content-type': 'video/mp4' } });
    } });
    await restored.initialize();
    await restored.resume();
    await restored._runTask;
    const result = restored.snapshot();
    assert.equal(result.skipped, 0);
    assert.equal(result.completed, replacementHasAudio ? 1 : 0);
    assert.equal(result.failed, replacementHasAudio ? 0 : 1);
    assert.ok(requests > 0);
    assert.equal(result.items[0].sequence, original.sequence);
    assert.equal(result.items[0].directoryName, original.directoryName);
    if (replacementHasAudio) {
      assert.equal(restored.state.items[0].files.find(file => file.key === 'video').mediaTracks.hasAudio, true);
      assert.deepEqual(await fs.readFile(filename), MP4);
    } else {
      assert.deepEqual(await fs.readFile(filename), silent, 'failed repair must preserve the existing downloaded file');
    }
  }
});

await t.test("primary-meta covers and live photos missing paired videos are never marked complete", async (t) => {
  for (const detail of [parsed({ strategy: "primary-meta-cover" }), parsed({ images: [{ url: imageUrl(), livePhoto: true }] })]) {
    const f = await fixture(t);
    f.manager.browser.resolveNote = async () => detail;
    await f.start();
    assert.equal((await f.settle()).failed, 1);
    assert.equal(f.requests.some((item) => item.type === "media"), false);
  }
});

await t.test("profile, timing, and discovery note URLs are validated before downloading", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.start({ intervalSeconds: 2 }), /3–3600/);
  await assert.rejects(f.start({ intervalSeconds: 3.1 }), /3–3600/);
  await assert.rejects(f.start({ jitterSeconds: 301 }), /0–300/);
  await assert.rejects(f.start({ profileUrl: "https://evil.example/user/profile/5e413a430000000001000f4c" }), /主页链接/);
  f.manager.browser.discover = async function* () { yield { notes: [{ ...note(), url: "https://evil.example/explore/" + A }], done: true }; };
  await f.start();
  assert.equal((await f.settle()).status, "error");
  assert.equal(f.requests.length, 0);
});

await t.test("redirects are checked individually and cannot downgrade HTTPS or reach foreign hosts", async (t) => {
  const f = await fixture(t);
  for (const location of ["https://evil.example/file.jpg", "http://ci.xiaohongshu.com/file.jpg", "https://ci.xiaohongshu.com:8443/file.jpg", "https://user:pass@ci.xiaohongshu.com/file.jpg"]) {
    const calls = [];
    await assert.rejects(downloadMedia({ root: f.directory, directory: f.directory, asset: { key: "test", kind: "image", url: imageUrl() }, beforeRequest: async () => {}, fetchImpl: async (url) => { calls.push(url); return new Response(null, { status: 302, headers: { location } }); } }), /重定向/);
    assert.equal(calls.length, 1);
  }
});

await t.test("streamed media enforces size, MIME and signature and leaves no .part files on failure", async (t) => {
  const f = await fixture(t);
  for (const [response, maxBytes] of [
    [new Response("<html>login</html>", { headers: { "content-type": "text/html" } }), 512],
    [new Response("<html>login</html>", { headers: { "content-type": "image/jpeg" } }), 512],
    [new Response(JPEG, { headers: { "content-type": "image/jpeg", "content-length": "500" } }), 512],
    [new Response(JPEG, { headers: { "content-type": "image/jpeg" } }), 8]
  ]) {
    await assert.rejects(downloadMedia({ root: f.directory, directory: f.directory, asset: { key: "test", kind: "image", url: imageUrl() }, maxBytes, beforeRequest: async () => {}, fetchImpl: async () => response }));
    assert.deepEqual(await fs.readdir(f.directory), []);
  }
});

await t.test("a note-directory symlink cannot redirect writes outside the chosen folder", async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.base, "outside");
  await fs.mkdir(outside);
  await fs.symlink(outside, noteFolder(f, A), process.platform === "win32" ? "junction" : "dir");
  await f.start();
  assert.equal((await f.settle()).failed, 1);
  assert.deepEqual(await fs.readdir(outside), []);
  assert.equal(f.requests.length, 0);
});

await t.test("Windows reserved filenames and path separators are sanitized", () => {
  assert.equal(safeFilename("CON"), "_CON");
  assert.equal(safeFilename("A/B\\C:*? ."), "A_B_C___");
  assert.equal(safeFilename(".."), "untitled");
  assert.equal(safeFilename("小红书视频"), "小红书视频");
});

await t.test("state persistence failure becomes a visible error without an unhandled background rejection", async (t) => {
  const f = await fixture(t);
  const original = f.manager._save.bind(f.manager);
  let saves = 0;
  f.manager._save = async () => { if (++saves > 1) throw new Error("ENOSPC fixture"); return original(); };
  await f.start();
  await f.settle();
  assert.equal(f.manager.snapshot().status, "error");
  assert.match(f.manager.snapshot().message, /ENOSPC fixture/);
});

await t.test("a partially completed note keeps verified media across a failed retry and restart", async (t) => {
  const f = await fixture(t);
  const first = imageUrl("first");
  const second = imageUrl("second");
  f.manager.browser.resolveNote = async () => parsed({ images: [{ url: first }, { url: second }] });
  let failing = true;
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return url === second && failing ? new Response("missing", { status: 404 }) : mediaResponse(url);
  };
  f.manager.fetchImpl = fetchImpl;
  await f.start();
  assert.equal((await f.settle()).failed, 1);
  assert.equal(urls.filter((url) => url === first).length, 1);
  failing = false;
  const restored = new ProfileManager({ ...f.config, fetchImpl });
  restored.browser = f.manager.browser;
  await restored.initialize();
  await restored.retryFailed();
  await restored._runTask;
  assert.equal(restored.snapshot().completed, 1);
  assert.equal(urls.filter((url) => url === first).length, 1);
  assert.deepEqual(await fs.readFile(path.join(noteFolder(f, A), "image-001.jpg")), JPEG);
});

await t.test("media is streamed over multiple chunks and atomically published with the exact bytes", async (t) => {
  const f = await fixture(t);
  const chunks = [JPEG.subarray(0, 2), JPEG.subarray(2, 6), JPEG.subarray(6)];
  const record = await downloadMedia({ root: f.directory, directory: f.directory,
    asset: { key: "stream", kind: "image", url: imageUrl() }, beforeRequest: async () => {},
    fetchImpl: async () => new Response(new ReadableStream({
      async pull(controller) {
        assert.equal((await fs.readdir(f.directory)).includes("stream.jpg"), false);
        if (chunks.length) controller.enqueue(chunks.shift());
        else controller.close();
      }
    }), { headers: { "content-type": "image/jpeg", "content-length": String(JPEG.length) } })
  });
  assert.equal(record.bytes, JPEG.length);
  assert.deepEqual(await fs.readFile(path.join(f.directory, "stream.jpg")), JPEG);
  assert.deepEqual(await fs.readdir(f.directory), ["stream.jpg"]);
});

await t.test("an existing media symlink cannot overwrite a file outside the download directory", async (t) => {
  const f = await fixture(t);
  const target = path.join(f.base, "outside.jpg");
  await fs.writeFile(target, "keep this file");
  await fs.symlink(target, path.join(f.directory, "stream.jpg"));
  await assert.rejects(downloadMedia({ root: f.directory, directory: f.directory,
    asset: { key: "stream", kind: "image", url: imageUrl() }, beforeRequest: async () => {}, fetchImpl: async () => mediaResponse(imageUrl())
  }), /不是普通文件/);
  assert.equal(await fs.readFile(target, "utf8"), "keep this file");
  assert.deepEqual(await fs.readdir(f.directory), ["stream.jpg"]);
});

await t.test("detail placeholder titles preserve homepage titles while real titles may equal the placeholder", async (t) => {
  for (const [titleSource, expected] of [["fallback", "真实主页标题"], ["note", "小红书图片"], ["page", "小红书图片"], [undefined, "小红书图片"]]) {
    const f = await fixture(t, { browser: {
      async *discover() { yield { notes: [{ ...note(A), title: "真实主页标题" }], done: true }; },
      async resolveNote() { return parsed({ title: "小红书图片", titleSource }); }
    } });
    await f.start(); const result = await f.settle();
    assert.equal(result.items[0].title, expected, titleSource);
    assert.equal(result.items[0].directoryName, `001-${expected}`, titleSource);
    const directory = noteFolder(f);
    const manifest = JSON.parse(await fs.readFile(path.join(directory, ".xhs-download.json"), "utf8"));
    const metadata = JSON.parse(await fs.readFile(path.join(directory, "笔记.json"), "utf8"));
    assert.equal(manifest.title, expected);
    assert.equal(metadata.title, expected);
  }
});

await t.test("note directories use stable discovery order and the resolved, cross-platform safe title", async (t) => {
  const f = await fixture(t);
  f.manager.browser = {
    async *discover() { yield { notes: [{ ...note(A), title: "截断标题…" }, { ...note(B), title: "" }], done: true }; },
    async resolveNote(item) { return parsed({ title: item.id === A ? "完整/标题?" : "" }); }
  };
  await f.start();
  const result = await f.settle();
  assert.deepEqual(result.items.map(item => [item.sequence, item.directoryName]), [[1, "001-完整_标题_"], [2, "002-未命名帖子"]]);
  assert.deepEqual((await fs.readdir(f.directory)).sort(), ["001-完整_标题_", "002-未命名帖子"]);
  for (const item of result.items) {
    const manifest = JSON.parse(await fs.readFile(path.join(f.directory, item.directoryName, ".xhs-download.json"), "utf8"));
    assert.equal(manifest.id, item.id);
    assert.equal(manifest.sequence, item.sequence);
    assert.equal(manifest.directoryName, item.directoryName);
    assert.equal(manifest.complete, true);
  }
  const restored = new ProfileManager(f.config);
  assert.deepEqual((await restored.initialize()).items.map(item => [item.sequence, item.directoryName]), result.items.map(item => [item.sequence, item.directoryName]));
});

await t.test("legacy v1.5 note-ID directories migrate without downloading verified files again", async (t) => {
  const f = await fixture(t);
  await f.start();
  await f.settle();
  const legacy = path.join(f.directory, A);
  await fs.rename(noteFolder(f), legacy);
  const manifestPath = path.join(legacy, ".xhs-download.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  delete manifest.sequence; delete manifest.directoryName; delete manifest.titleResolved;
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const statePath = path.join(f.stateDirectory, "profile-job.json");
  const saved = JSON.parse(await fs.readFile(statePath, "utf8"));
  for (const item of saved.items) { delete item.sequence; delete item.directoryName; delete item.titleResolved; }
  await fs.writeFile(statePath, JSON.stringify(saved));
  f.requests.length = 0;
  const restored = new ProfileManager(f.config);
  assert.equal((await restored.initialize()).items[0].sequence, 1);
  await restored.resume(); await restored._runTask;
  const result = restored.snapshot();
  assert.equal(result.skipped, 1);
  assert.equal(result.items[0].directoryName, "001-测试标题__路径");
  assert.equal(f.requests.length, 0);
  await assert.rejects(fs.access(legacy), { code: "ENOENT" });
  assert.deepEqual(await fs.readFile(path.join(f.directory, result.items[0].directoryName, "image-001.jpg")), JPEG);
});

await t.test("a renamed directory is recovered by manifest ID after interruption before state was saved", async (t) => {
  const f = await fixture(t);
  await f.start(); await f.settle();
  await fs.rename(noteFolder(f), path.join(f.directory, "001-中断时的目录名"));
  f.requests.length = 0;
  const restored = new ProfileManager(f.config);
  await restored.initialize(); await restored.resume(); await restored._runTask;
  assert.equal(restored.snapshot().skipped, 1);
  assert.equal(f.requests.length, 0);
  assert.deepEqual(await fs.readdir(f.directory), ["001-测试标题__路径"]);
});

await t.test("directory-name conflicts preserve unrelated content and use a deterministic note-ID suffix", async (t) => {
  const f = await fixture(t);
  const occupied = path.join(f.directory, "001-测试标题__路径");
  await fs.mkdir(occupied);
  await fs.writeFile(path.join(occupied, "do-not-touch.txt"), "保留其他文件");
  await fs.writeFile(path.join(occupied, ".xhs-download.json"), JSON.stringify({ version: 1, id: B, files: [], complete: false }));
  await f.start();
  const result = await f.settle();
  assert.equal(result.completed, 1);
  assert.equal(result.items[0].directoryName, `001-测试标题__路径-${A}`);
  assert.equal(await fs.readFile(path.join(occupied, "do-not-touch.txt"), "utf8"), "保留其他文件");
  f.requests.length = 0;
  await f.manager.resume(); await f.settle();
  assert.equal(f.manager.snapshot().items[0].directoryName, result.items[0].directoryName);
  assert.equal(f.requests.length, 0);
});

await t.test("title-based directory collisions cannot traverse a symlink or overwrite its destination", async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.base, "untouched");
  await fs.mkdir(outside); await fs.writeFile(path.join(outside, "keep.txt"), "keep");
  await fs.symlink(outside, path.join(f.directory, "001-测试标题__路径"), process.platform === "win32" ? "junction" : "dir");
  await f.start();
  assert.equal((await f.settle()).completed, 1);
  assert.deepEqual(await fs.readdir(outside), ["keep.txt"]);
  assert.equal(await fs.readFile(path.join(outside, "keep.txt"), "utf8"), "keep");
});

await t.test("single-item and retry-all preserve sequence and never re-request successful posts", async (t) => {
  const C = "333333333333333333333333";
  const f = await fixture(t);
  const failures = new Set([B, C]);
  const resolved = [];
  f.manager.browser = {
    async *discover() { yield { notes: [note(A), note(B), note(C)], done: true }; },
    async resolveNote(item) { resolved.push(item.id); if (failures.has(item.id)) throw new Error("temporary fixture failure"); return parsed({ title: `帖子-${item.id}` }); }
  };
  await f.start(); await f.settle();
  assert.equal(f.manager.snapshot().failed, 2);
  const original = f.manager.snapshot().items.map(item => ({ id: item.id, sequence: item.sequence, directoryName: item.directoryName }));
  const firstImage = await fs.readFile(path.join(noteFolder(f, A), "image-001.jpg"));
  resolved.length = 0; f.requests.length = 0; failures.delete(B);
  await f.manager.retryItem(B); await f.settle();
  assert.deepEqual(resolved, [B]);
  assert.equal(f.manager.snapshot().items[0].status, "completed");
  assert.equal(f.manager.snapshot().items[2].status, "failed");
  assert.deepEqual(await fs.readFile(path.join(noteFolder(f, A), "image-001.jpg")), firstImage);
  assert.deepEqual(f.manager.snapshot().items.map(item => item.sequence), [1, 2, 3]);
  assert.equal(f.manager.snapshot().items[0].directoryName, original[0].directoryName);
  resolved.length = 0; failures.delete(C);
  await f.manager.retryFailed(); await f.settle();
  assert.deepEqual(resolved, [C]);
  assert.equal(f.manager.snapshot().completed, 3);
  await assert.rejects(f.manager.retryItem(A), /只有失败/);
  await assert.rejects(f.manager.retryItem("../outside"), /ID 无效/);
});

await t.test("retrying one failed item leaves pending discovery and other queue items paused", async (t) => {
  const f = await fixture(t);
  const saved = { ...f.manager.state, profileUrl: PROFILE, directory: f.directory, status: "paused", discoveryComplete: false,
    items: [{ ...note(A), status: "failed", error: "old error", files: [], complete: false }, { ...note(B), status: "pending", files: [], complete: false }] };
  await fs.writeFile(path.join(f.stateDirectory, "profile-job.json"), JSON.stringify(saved));
  const calls = [];
  const restored = new ProfileManager({ ...f.config, browser: {
    async *discover() { throw new Error("single retry must not discover"); },
    async resolveNote(item) { calls.push(item.id); return parsed(); }
  } });
  await restored.initialize(); await restored.retryItem(A); await restored._runTask;
  assert.deepEqual(calls, [A]);
  const result = restored.snapshot();
  assert.equal(result.status, "paused");
  assert.equal(result.discoveryComplete, false);
  assert.equal(result.items[1].status, "pending");
  assert.deepEqual(result.items.map(item => item.sequence), [1, 2]);
});

await t.test("active tasks clearly reject item retries without altering failed queue entries", async (t) => {
  let started;
  const waiting = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { sleep: async (_ms, signal) => {
    started();
    await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("stop"), { name: "AbortError" })), { once: true }));
  } });
  await f.start(); await waiting;
  await assert.rejects(f.manager.retryItem(A), /请先暂停/);
  await assert.rejects(f.manager.retryFailed(), /请先暂停/);
  await f.manager.pause();
});

await t.test("persisted path traversal is rejected and long Unicode titles remain safe filename components", async (t) => {
  const f = await fixture(t);
  f.manager.browser.resolveNote = async () => parsed({ title: "😀".repeat(100) + "/.." });
  await f.start(); await f.settle();
  const item = f.manager.snapshot().items[0];
  assert.ok(Buffer.byteLength(item.directoryName, "utf8") <= 240);
  assert.equal(path.basename(item.directoryName), item.directoryName);
  const file = path.join(f.stateDirectory, "profile-job.json");
  const saved = JSON.parse(await fs.readFile(file, "utf8"));
  saved.items[0].directoryName = "../outside";
  await fs.writeFile(file, JSON.stringify(saved));
  const restored = new ProfileManager(f.config);
  assert.equal((await restored.initialize()).status, "error");
});

await t.test("rediscovery keeps existing sequence and resolved titles while new posts receive the next number", async (t) => {
  const C = "333333333333333333333333";
  const f = await fixture(t);
  let round = 0;
  const resolved = [];
  f.manager.browser = {
    async *discover() {
      round++;
      yield { notes: (round === 1 ? [A, B] : [C, B, A]).map(id => ({ ...note(id), title: "短标题…" })), done: true };
    },
    async resolveNote(item) { resolved.push(item.id); return parsed({ title: `完整标题-${item.id}` }); }
  };
  await f.start(); await f.settle();
  const first = f.manager.snapshot().items.map(item => ({ id: item.id, sequence: item.sequence, directoryName: item.directoryName }));
  resolved.length = 0;
  await f.start(); await f.settle();
  assert.deepEqual(resolved, [C]);
  assert.deepEqual(f.manager.snapshot().items.slice(0, 2).map(item => ({ id: item.id, sequence: item.sequence, directoryName: item.directoryName })), first);
  assert.equal(f.manager.snapshot().items[2].sequence, 3);
  assert.match(f.manager.snapshot().items[2].directoryName, /^003-完整标题/);
});

}
