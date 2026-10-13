'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { translateCues } = require('../electron/core/deepseek.cjs');
const cues = [{ id: 11, start: 1.23, end: 4.56, text: 'Hello.' }, { id: 12, start: 5.67, end: 8.9, text: 'Welcome.' }];
const options = { mode: 'bilingual', targetLanguage: '简体中文', chunkSize: 10, polish: false };
const runtime = { retryDelayMs: 0, minIntervalMs: 0 };
const success = lines => ({ ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ lines }) } }] }) });
test.before(() => { process.env.Deepseek = 'test-key-never-log'; });

test('translation preserves timings and IDs, sends text only and restores source order', async () => {
  const result = await translateCues(cues, options, { ...runtime, fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body); const payload = JSON.parse(body.messages[1].content);
    assert.deepEqual(payload.lines, cues.map(({ id, text }) => ({ id, text })));
    assert.equal(body.reasoning_effort, 'none');
    return success([{ id: 12, translation: '欢迎。', start: 99 }, { id: 11, translation: '你好。', end: 99 }]);
  } });
  assert.deepEqual(result, [{ ...cues[0], translation: '你好。' }, { ...cues[1], translation: '欢迎。' }]);
  assert.equal(cues[0].translation, undefined);
});

test('source mode proofreads without changing timing or adding translation', async () => {
  const result = await translateCues([cues[0]], { ...options, mode: 'source' }, { ...runtime,
    fetchImpl: async () => success([{ id: 11, text: 'Hello!', start: 100, translation: 'ignored' }]) });
  assert.deepEqual(result, [{ ...cues[0], text: 'Hello!' }]);
});

test('optional polish updates text and translation only', async () => {
  const result = await translateCues([cues[0]], { ...options, polish: true }, { ...runtime,
    fetchImpl: async () => success([{ id: 11, text: 'Hello!', translation: '你好！' }]) });
  assert.deepEqual(result, [{ ...cues[0], text: 'Hello!', translation: '你好！' }]);
});

test('duplicate and missing IDs never silently overwrite cues', async () => {
  await assert.rejects(translateCues(cues, options, { ...runtime,
    fetchImpl: async () => success([{ id: 11, translation: '一' }, { id: 11, translation: '二' }]) }), /数量|ID/);
});

test('malformed response fails after bounded retries', async () => {
  let calls = 0;
  await assert.rejects(translateCues([cues[0]], options, { ...runtime, fetchImpl: async () => {
    calls++; return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '{broken' } }] }) };
  } }), /JSON/);
  assert.equal(calls, 3);
});

test('authentication failure is not retried or disclosed', async () => {
  let calls = 0;
  await assert.rejects(translateCues(cues, options, { ...runtime, fetchImpl: async () => {
    calls++; return { ok: false, status: 401, headers: new Headers(), json: async () => ({ error: 'test-key-never-log' }) };
  } }), error => error.message.includes('密钥无效') && !error.message.includes('test-key-never-log'));
  assert.equal(calls, 1);
});

test('cancellation aborts an active request', async () => {
  const controller = new AbortController();
  const pending = translateCues(cues, options, { ...runtime, signal: controller.signal,
    fetchImpl: async (url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('internal-secret')), { once: true });
      controller.abort();
    }) });
  await assert.rejects(pending, { name: 'AbortError' });
});

test('timeout failures are sanitized and bounded', async () => {
  let calls = 0;
  await assert.rejects(translateCues([cues[0]], options, { ...runtime, requestTimeoutMs: 5,
    fetchImpl: async (url, { signal }) => new Promise((resolve, reject) => {
      calls++; signal.addEventListener('abort', () => reject(new Error('internal-secret')), { once: true });
    }) }), /超时/);
  assert.equal(calls, 3);
});

test('batch checkpoints are awaited and snapshots cannot mutate returned cues', async () => {
  const saved = []; let persisted = false; let calls = 0;
  const result = await translateCues(cues, { ...options, chunkSize: 1 }, { ...runtime,
    fetchImpl: async (url, init) => {
      if (calls++) assert.equal(persisted, true);
      const { lines } = JSON.parse(JSON.parse(init.body).messages[1].content);
      return success(lines.map(line => ({ id: line.id, translation: '译文' })));
    },
    onBatchComplete: async snapshot => {
      await new Promise(resolve => setImmediate(resolve));
      saved.push(structuredClone(snapshot)); persisted = true;
      snapshot[0].start = 999; snapshot[0].translation = 'mutated'; snapshot.push({ id: 999 });
    }
  });
  assert.deepEqual(saved.map(snapshot => snapshot.length), [1, 2]);
  assert.equal(result[0].start, cues[0].start);
  assert.equal(result[0].translation, '译文');
  assert.equal(result.length, 2);
});

test('later malformed responses preserve only earlier validated batches', async () => {
  const checkpoints = []; let calls = 0;
  await assert.rejects(translateCues(cues, { ...options, chunkSize: 1 }, { ...runtime,
    fetchImpl: async () => ++calls === 1 ? success([{ id: 11, translation: '你好。' }]) : success([{ id: 999, translation: '错误' }]),
    onBatchComplete: async snapshot => checkpoints.push(snapshot)
  }), /ID/);
  assert.equal(calls, 4);
  assert.deepEqual(checkpoints, [[{ ...cues[0], translation: '你好。' }]]);
});

test('failed subdivision never checkpoints an incomplete original batch', async () => {
  let checkpoints = 0;
  await assert.rejects(translateCues(cues, options, { ...runtime,
    fetchImpl: async (url, init) => {
      const { lines } = JSON.parse(JSON.parse(init.body).messages[1].content);
      return lines.length === 1 && lines[0].id === 11
        ? success([{ id: 11, translation: '你好。' }]) : success([]);
    }, onBatchComplete: async () => { checkpoints++; }
  }), /数量/);
  assert.equal(checkpoints, 0);
});

test('resume skips completed batches and extends the persisted prefix', async () => {
  const prefix = [{ ...cues[0], translation: '已完成' }]; const requested = []; const checkpoints = [];
  const result = await translateCues(cues, { ...options, chunkSize: 1 }, { ...runtime, resumeCues: prefix,
    fetchImpl: async (url, init) => {
      const { lines } = JSON.parse(JSON.parse(init.body).messages[1].content);
      requested.push(...lines.map(line => line.id)); return success([{ id: 12, translation: '新增译文' }]);
    }, onBatchComplete: async snapshot => checkpoints.push(snapshot)
  });
  assert.deepEqual(requested, [12]);
  assert.deepEqual(result, [...prefix, { ...cues[1], translation: '新增译文' }]);
  assert.deepEqual(checkpoints, [result]);
});

test('invalid resume structure or batch boundary is rejected before any request', async () => {
  let calls = 0;
  const completed = cues.map(cue => ({ ...cue, translation: '译文' }));
  const badPrefixes = [
    [completed[0]], // Ends halfway through the original two-cue batch.
    [{ ...completed[0], start: 999 }, completed[1]],
    [{ ...completed[0], text: 'changed' }, completed[1]],
    [completed[1], completed[0]],
    [completed[0], { ...completed[1], translation: '' }],
    { invalid: true }
  ];
  for (const resumeCues of badPrefixes) await assert.rejects(translateCues(cues, options, { ...runtime, resumeCues,
    fetchImpl: async () => { calls++; return success([]); } }), /恢复数据/);
  assert.equal(calls, 0);
});

test('fully completed polished or proofread prefix returns without another API call', async () => {
  let calls = 0;
  for (const config of [{ ...options, polish: true }, { ...options, mode: 'source' }]) {
    const resumeCues = cues.map(cue => ({ ...cue, text: 'Proofread.', ...(config.mode === 'source' ? {} : { translation: '译文' }) }));
    const result = await translateCues(cues, config, { ...runtime, resumeCues,
      fetchImpl: async () => { calls++; return success([]); } });
    assert.deepEqual(result, resumeCues);
  }
  assert.equal(calls, 0);
});

test('checkpoint write failure stops requests and is never retried as a network failure', async () => {
  let calls = 0;
  await assert.rejects(translateCues(cues, { ...options, chunkSize: 1 }, { ...runtime,
    fetchImpl: async () => { calls++; return success([{ id: 11, translation: '你好' }]); },
    onBatchComplete: async () => { throw new Error('storage error'); }
  }), /无法保存翻译批次进度/);
  assert.equal(calls, 1);
});

test('abort during checkpoint keeps validated progress but prevents another request', async () => {
  const controller = new AbortController(); let calls = 0; let saved;
  await assert.rejects(translateCues(cues, { ...options, chunkSize: 1 }, { ...runtime, signal: controller.signal,
    fetchImpl: async () => { calls++; return success([{ id: 11, translation: '你好' }]); },
    onBatchComplete: async snapshot => { saved = snapshot; controller.abort(); }
  }), { name: 'AbortError' });
  assert.equal(calls, 1);
  assert.deepEqual(saved, [{ ...cues[0], translation: '你好' }]);
});
