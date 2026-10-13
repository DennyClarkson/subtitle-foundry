'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { whisperCues } = require('../electron/core/asr.cjs');
const tok = (text, id, from, to) => ({ text, id, offsets: { from, to } });

test('ASR keeps high ordinary multilingual token IDs, excludes special tokens and preserves source offsets', () => {
  const cues = whisperCues({ transcription: [{ text: '你好世界', offsets: { from: 0, to: 4000 }, tokens: [
    tok('[_SOT_]', 50258, 0, 1), tok('你', 40001, 0, 1000), tok('好', 40002, 1000, 2000),
    tok('世', 49000, 2000, 3000), tok('界', 50000, 3000, 4000), tok('[_EOT_]', 50257, 4000, 4001)
  ] }] }, { offset: 10, maxDuration: 2 });
  assert.deepEqual(cues, [{ id: 1, start: 10, end: 12, text: '你好', speechEnd:12 }, { id: 2, start: 12, end: 14, text: '世界', speechEnd:14 }]);
});

test('ASR never substitutes incomplete token coverage for the recognized segment', () => {
  const cues = whisperCues({ transcription: [{ text: 'First second third', offsets: { from: 0, to: 9000 },
    tokens: [tok('First', 100, 0, 3000), tok(' third', 101, 6000, 9000)] }] }, { maxDuration: 3 });
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, 'First second third');
  assert.equal(cues[0].end, 9);
});

test('ASR rejects empty results instead of reporting success', () => {
  assert.throws(() => whisperCues({ transcription: [{ text: '', offsets: { from: 0, to: 1000 } }] }), /没有识别到语音/);
});

test('ASR output remains positive and monotonic when segments overlap', () => {
  const cues = whisperCues({ transcription: [
    { text: 'first', offsets: { from: 0, to: 4000 } },
    { text: 'second', offsets: { from: 3000, to: 6000 } }
  ] });
  assert.equal(cues[1].start, cues[0].end);
  assert.ok(cues.every(cue => cue.end > cue.start));
});

test('ASR cleanup failure preserves extraction, Whisper and parse errors but fails an otherwise successful job', async () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../electron/core/asr.cjs'), 'utf8');
  for (const failure of ['extract', 'whisper', 'parse', 'none']) {
    const primary = new Error(`${failure} failed`);
    const cleanup = Object.assign(new Error('audio.wav is locked'), { code: 'EPERM' });
    let runs = 0, removals = 0;
    const fakeFs = {
      access: async () => {}, writeFile: async () => {},
      readFile: async () => failure === 'parse' ? '{invalid' : JSON.stringify({ transcription: [{ text: 'Hello', offsets: { from: 0, to: 1000 } }] }),
      rm: async file => { assert.equal(file, path.join('job', 'audio.wav')); removals++; throw cleanup; }
    };
    const module = { exports: {} };
    vm.runInNewContext(source, { module, require: name => {
      if (name === 'node:fs/promises') return fakeFs;
      if (name === '../paths.cjs') return { paths: { ffmpeg: 'ffmpeg', whisper: 'whisper' } };
      if (name === './models.cjs') return { modelPath: () => 'model.bin' };
      if (name === './process.cjs') return { run: async () => {
        runs++;
        if ((failure === 'extract' && runs === 1) || (failure === 'whisper' && runs === 2)) throw primary;
      } };
      return require(name);
    } });
    await assert.rejects(module.exports.transcribe({ duration: 5, path: 'video.mp4' }, { model: 'base' }, 'job'), error => {
      if (failure === 'none') return error === cleanup;
      if (failure === 'parse') return error.name === 'SyntaxError' && error !== cleanup;
      return error === primary;
    });
    assert.equal(removals, 1, `${failure}: cleanup must still be attempted`);
  }
});
