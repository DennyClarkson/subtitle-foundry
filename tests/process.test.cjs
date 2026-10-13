'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { run } = require('../electron/core/process.cjs');
const { paths, inside, assertInside } = require('../electron/paths.cjs');

test('process arguments are passed literally without shell interpretation', async () => {
  const argument = '中文路径 & echo unexpected | %TEMP%';
  const { stdout } = await run(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', argument]);
  assert.equal(stdout, argument);
});

test('process output decodes UTF-8 characters spanning OS chunks', async () => {
  const script = `const bytes=Buffer.from('中文标题'); process.stdout.write(bytes.subarray(0,1)); setTimeout(()=>process.stdout.write(bytes.subarray(1)),100);`;
  const { stdout } = await run(process.execPath, ['-e', script]);
  assert.equal(stdout, '中文标题');
});

test('process cancellation terminates a running child', async () => {
  const controller = new AbortController();
  const result = run(process.execPath, ['-e', 'process.stdout.write("ready");setInterval(()=>{},1000)'], {
    signal: controller.signal, onOutput() { controller.abort(); }
  });
  await assert.rejects(result, { name: 'AbortError' });
});

test('process timeout rejects instead of leaving a hanging task', async () => {
  await assert.rejects(run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 100 }), /超时/);
});

test('progress callback failures reject and terminate the child without crashing the app', async () => {
  await assert.rejects(run(process.execPath, ['-e', 'process.stdout.write("ready");setInterval(()=>{},1000)'], {
    onOutput() { throw new Error('Cannot save progress'); }
  }), /Cannot save progress/);
});

test('pre-cancelled operation never starts a child', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(run('nonexistent-should-not-spawn', [], { signal: controller.signal }), { name: 'AbortError' });
});

test('subprocess cache and temporary paths stay in the portable root', async () => {
  const { stdout } = await run(process.execPath, ['-e', 'process.stdout.write(JSON.stringify([process.env.TEMP,process.env.TMP,process.env.CUDA_CACHE_PATH,process.env.HF_HOME]))']);
  assert.ok(JSON.parse(stdout).every(file => inside(file)));
});

test('containment rejects parent traversal and prefix siblings', () => {
  assert.equal(inside(path.join(paths.root, 'outputs', '字幕.ass')), true);
  assert.equal(inside(path.resolve(paths.root, '..', 'outside.txt')), false);
  assert.equal(inside(paths.root + '-sibling' + path.sep + 'output.txt'), false);
  assert.throws(() => assertInside(path.resolve(paths.root, '..', 'outside.txt')), /便携应用/);
});
