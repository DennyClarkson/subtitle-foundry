'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { MediaRegistry } = require('../electron/media.cjs');
const { paths, assertInside } = require('../electron/paths.cjs');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(paths.temp, 'media-lifecycle-test-'));
  const file = path.join(directory, 'video 测试.mp4');
  const empty = path.join(directory, 'empty.mp4');
  const content = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < content.length; i++) content[i] = i % 251;
  await fs.writeFile(file, content);
  await fs.writeFile(empty, '');
  t.after(async () => {
    assertInside(directory, paths.temp);
    assert.match(path.basename(directory), /^media-lifecycle-test-/);
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { file, empty, content };
}

async function closed(registry) {
  const deadline = Date.now() + 3000;
  while (registry.stats().streams && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(registry.stats().streams, 0, 'all OS file streams must close');
}

async function renameRoundtrip(file) {
  const moved = file + '.renamed';
  await fs.rename(file, moved);
  await fs.rename(moved, file);
}

test('media URL registrations remain bounded during 1000 replacements and evicted URLs expire', async t => {
  const { file } = await fixture(t);
  const registry = new MediaRegistry();
  t.after(() => registry.dispose());
  const first = registry.register(file);
  for (let i = 0; i < 1000; i++) {
    const url = registry.register(file);
    if (i % 3 === 0) registry.release(url);
    assert.ok(registry.stats().registrations <= 128);
  }
  assert.equal((await registry.response(new Request(first))).status, 404);
  registry.release('not a URL');
  registry.dispose();
  assert.deepEqual(registry.stats(), { registrations: 0, streams: 0 });
  assert.throws(() => registry.register(file), /关闭/);
});

test('media supports exact, open and suffix byte ranges and HEAD without opening streams', async t => {
  const { file, content } = await fixture(t);
  const registry = new MediaRegistry();
  t.after(() => registry.dispose());
  const url = registry.register(file);
  for (const [range, start, end] of [['bytes=10-29', 10, 29], ['bytes=-20', content.length - 20, content.length - 1], [`bytes=${content.length - 20}-`, content.length - 20, content.length - 1], [`bytes=${content.length - 2}-${content.length + 100}`, content.length - 2, content.length - 1]]) {
    const response = await registry.response(new Request(url, { headers: { Range: range } }));
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${content.length}`);
    assert.equal(Number(response.headers.get('content-length')), end - start + 1);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), content.subarray(start, end + 1));
    await closed(registry);
  }
  const head = await registry.response(new Request(url, { method: 'HEAD', headers: { Range: 'bytes=0-9' } }));
  assert.equal(head.status, 206);
  assert.equal(head.headers.get('content-type'), 'video/mp4');
  assert.equal(head.headers.get('accept-ranges'), 'bytes');
  assert.equal(head.headers.get('content-length'), '10');
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal(registry.stats().streams, 0);
  const full = await registry.response(new Request(url));
  assert.equal(full.status, 200);
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), content);
  await closed(registry);
  await renameRoundtrip(file);
});

test('invalid ranges, empty files and released URLs return bounded responses without streams', async t => {
  const { file, empty, content } = await fixture(t);
  const registry = new MediaRegistry();
  t.after(() => registry.dispose());
  const url = registry.register(file), emptyUrl = registry.register(empty);
  for (const range of ['bytes=-0', 'bytes=-', 'bytes=5-4', `bytes=${content.length}-`, 'bytes=0-1,4-5', 'bytes=abc-def']) {
    const response = await registry.response(new Request(url, { headers: { Range: range } }));
    assert.equal(response.status, 416, range);
    assert.equal(response.headers.get('content-range'), `bytes */${content.length}`);
    assert.equal((await response.arrayBuffer()).byteLength, 0);
  }
  const blank = await registry.response(new Request(emptyUrl));
  assert.equal(blank.status, 200);
  assert.equal(blank.headers.get('content-length'), '0');
  assert.equal((await blank.arrayBuffer()).byteLength, 0);
  assert.equal((await registry.response(new Request(emptyUrl, { headers: { Range: 'bytes=0-' } }))).status, 416);
  assert.equal((await registry.response(new Request(url, { method: 'POST' }))).status, 405);
  registry.release(url);
  assert.equal((await registry.response(new Request(url))).status, 404);
  assert.equal((await registry.response(new Request('media://other/key/file.mp4'))).status, 404);
  assert.equal(registry.stats().streams, 0);
});

test('cancelling response bodies, request aborts and URL release close file streams repeatedly', async t => {
  const { file } = await fixture(t);
  const registry = new MediaRegistry();
  t.after(() => registry.dispose());
  for (let i = 0; i < 24; i++) {
    const url = registry.register(file);
    const controller = new AbortController();
    const response = await registry.response(new Request(url, { signal: controller.signal }));
    const reader = response.body.getReader();
    assert.equal((await reader.read()).done, false);
    if (i % 3 === 0) await reader.cancel();
    else {
      if (i % 3 === 1) controller.abort();
      else registry.release(url);
      // A consumer must observe the stream rejection after its owner is released.
      await reader.closed.catch(() => {});
    }
    reader.releaseLock();
    await closed(registry);
    registry.release(url);
    assert.equal(registry.stats().registrations, 0);
    await renameRoundtrip(file);
  }
  const controller = new AbortController();
  controller.abort();
  const url = registry.register(file);
  assert.equal((await registry.response(new Request(url, { signal: controller.signal }))).status, 499);
  await closed(registry);
});

test('LRU eviction and disposal close concurrent abandoned readers and invalidate registrations', async t => {
  const { file } = await fixture(t);
  const registry = new MediaRegistry(4);
  t.after(() => registry.dispose());
  const readers = [];
  for (let i = 0; i < 4; i++) {
    const url = registry.register(file);
    const response = await registry.response(new Request(url));
    const reader = response.body.getReader();
    reader.closed.catch(() => {});
    await reader.read();
    readers.push(reader);
  }
  assert.equal(registry.stats().streams, 4);
  registry.register(file);
  await readers[0].closed.catch(() => {});
  registry.dispose();
  await Promise.all(readers.map(reader => reader.closed.catch(() => {})));
  for (const reader of readers) reader.releaseLock();
  await closed(registry);
  assert.deepEqual(registry.stats(), { registrations: 0, streams: 0 });
  await renameRoundtrip(file);
});
