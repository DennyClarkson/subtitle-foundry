'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { applyCueTiming } = require('../shared/timing.mjs');
const { normalizeStyle, normalizeCues, normalizeWorkflowCues, buildAss, serializeSrt, parseSrt } = require('../electron/core/subtitles.cjs');
const { whisperCues } = require('../electron/core/asr.cjs');
const { builtinPreset, normalizePreset } = require('../shared/workflow.cjs');
const cue = (start, end, extra = {}) => ({ id: 1, start, end, text: 'A sentence.', ...extra });

test('word-tail trim, manual trim and duration cap derive times without changing source', () => {
  const raw = [cue(1, 8, { speechEnd: 3, translation: '一句话。' })];
  const style = { trimToSpeechEnd: true, endPaddingMs: 80, endTrimMs: 100 };
  assert.equal(applyCueTiming(raw, style)[0].end, 2.98);
  assert.equal(applyCueTiming(raw, { ...style, maxCueDuration: 1 })[0].end, 2);
  assert.equal(raw[0].end, 8);
  assert.equal(applyCueTiming(raw, style)[0].translation, '一句话。');
  assert.equal(applyCueTiming(raw, { endTrimMs: 5000, maxCueDuration: 0.01 })[0].end, 1.01);
});

test('short-gap fill has inclusive threshold, leaves long pauses and never extends last cue', () => {
  const raw = [cue(0, 1), cue(1.2, 2), cue(2.201, 3), cue(10, 11)];
  assert.deepEqual(applyCueTiming(raw, { fillGapsMs: 200 }).map(c => c.end), [1.2, 2, 3, 11]);
  assert.deepEqual(applyCueTiming(raw).map(c => c.end), [1, 2, 3, 11]);
  assert.equal(applyCueTiming(raw, { fillGapsMs: 200, maxCueDuration: 1.1 })[0].end, 1);
});

test('fill follows trim while retaining existing overlaps and sub-centisecond cues', () => {
  assert.equal(applyCueTiming([cue(0, 2, { speechEnd: 1.8 }), cue(2, 3)], { trimToSpeechEnd: true, endPaddingMs: 0, fillGapsMs: 200 })[0].end, 2);
  const overlapping = [cue(0, 2), cue(1, 3), cue(4, 4.001)];
  assert.deepEqual(applyCueTiming(overlapping, { fillGapsMs: 200 }).map(c => c.end), [2, 3, 4.001]);
  assert.equal(applyCueTiming([cue(4, 4.001)], { endTrimMs: 5000 })[0].end, 4.001);
});

test('missing or invalid speech metadata falls back to original end and manual controls', () => {
  for (const speechEnd of [undefined, NaN, Infinity, -1, 0, 3, '1.2']) {
    const raw = [cue(0, 2, { speechEnd })];
    assert.equal(applyCueTiming(raw, { trimToSpeechEnd: true })[0].end, 2);
    assert.equal(applyCueTiming(raw, { trimToSpeechEnd: true, endTrimMs: 100 })[0].end, 1.9);
    assert.equal(normalizeCues(raw)[0].speechEnd, undefined);
  }
  assert.equal(normalizeCues([cue(0, 2, { speechEnd: 1.2 })])[0].speechEnd, 1.2);
});

test('punctuation normalization is timing-neutral and repeated ASS/SRT exports do not accumulate trims', () => {
  const raw = [cue(1, 8, { speechEnd: 3 })];
  const style = { subtitleMode: 'source', trimToSpeechEnd: true, endTrimMs: 100, endPaddingMs: 0, stripFinalPeriod: true, offset: 1 };
  assert.equal(normalizeWorkflowCues(raw, style)[0].end, 8);
  assert.equal(normalizeWorkflowCues(raw, style)[0].text, 'A sentence');
  const ass = buildAss(raw, style);
  assert.match(ass, /0:00:02\.00,0:00:03\.90/);
  assert.equal(buildAss(raw, style), ass);
  const srt = serializeSrt(applyCueTiming(raw, style));
  assert.equal(parseSrt(srt)[0].end, 2.9);
  assert.equal(serializeSrt(applyCueTiming(raw, style)), srt);
  assert.equal(raw[0].end, 8);
});

test('timing options reject malformed settings and presets enforce numeric types', () => {
  for (const [key, value] of [['endPaddingMs', 2001], ['endTrimMs', -1], ['fillGapsMs', 1.5], ['endTrimMs', null], ['fillGapsMs', true], ['maxCueDuration', 31], ['maxCueDuration', 0.001], ['trimToSpeechEnd', 'true'], ['endPaddingMs', Infinity]]) {
    assert.throws(() => normalizeStyle({ [key]: value }));
    assert.throws(() => applyCueTiming([], { [key]: value }));
  }
  assert.throws(() => normalizePreset({ ...builtinPreset, settings: { style: { endPaddingMs: '80' } } }), /类型/);
  for (const raw of [[cue(NaN, 2)], [cue(-1, 2)], [cue(2, 2)], [cue(0, Infinity)]]) assert.throws(() => applyCueTiming(raw), /时间/);
  assert.equal(builtinPreset.settings.style.trimToSpeechEnd, true);
  assert.equal(builtinPreset.settings.style.fillGapsMs, 200);
});

const token = (text, from, to) => ({ text, offsets: { from, to } });
const transcript = tokens => ({ transcription: [{ text: 'Hello world.', offsets: { from: 0, to: 4000 }, tokens }] });
test('ASR records last lexical end, ignoring punctuation/control timing and adding source offset', () => {
  const cues = whisperCues(transcript([token('[_BEG_]', 0, 0), token('Hello', 0, 500), token(' world', 500, 2200), token('.', 2200, 3990), token('<|endoftext|>', 4000, 4000)]), { offset: 10 });
  assert.equal(cues[0].speechEnd, 12.2);
  assert.equal(cues[0].end, 14);
  assert.equal(applyCueTiming(cues, { trimToSpeechEnd: true, endPaddingMs: 80 })[0].end, 12.28);
});

test('ASR does not trim to earlier words when final token is untimed, incomplete or out of range', () => {
  for (const tokens of [
    [token('Hello', 0, 500), token(' world', 4000, 4000), token('.', 4000, 4000)],
    [token('Hello', 0, 500), token(' world', 3500, 5000), token('.', 5000, 5000)],
    [token('Hello', 0, 500)],
    [token('Hello', 0, 500), token(' world', NaN, 2200), token('.', 2200, 4000)]
  ]) assert.equal(whisperCues(transcript(tokens))[0].speechEnd, undefined);
});

test('ASR removes scratch WAV after settled success, failure and cancellation, preserving transcripts', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../electron/core/asr.cjs'), 'utf8');
  for (const failAt of [0, 1, 2, 3]) {
    const calls = [];
    let runs = 0;
    const abort = new Error(failAt === 3 ? 'cancelled' : 'process failed');
    const stubFs = {
      access: async () => {},
      readFile: async () => JSON.stringify(transcript([token('Hello', 0, 500), token(' world', 500, 2200), token('.', 2200, 4000)])),
      writeFile: async file => { calls.push(['write', file]); },
      rm: async (file, options) => { calls.push(['remove', file, options.force]); }
    };
    const module = { exports: {} };
    vm.runInNewContext(source, { module, require: name => {
      if (name === 'node:fs/promises') return stubFs;
      if (name === '../paths.cjs') return { paths: { ffmpeg: 'ffmpeg', whisper: 'whisper' } };
      if (name === './models.cjs') return { modelPath: () => 'model.bin' };
      if (name === './process.cjs') return { run: async () => {
        runs++;
        await Promise.resolve();
        calls.push(['settled', runs]);
        if (runs === failAt || (failAt === 3 && runs === 2)) throw abort;
      } };
      return require(name);
    } });
    const job = module.exports.transcribe({ duration: 5, path: 'video.mp4' }, { model: 'base' }, 'job');
    if (failAt) await assert.rejects(job, error => error === abort);
    else assert.equal((await job).cues[0].speechEnd, 2.2);
    assert.deepEqual(calls.at(-1), ['remove', path.join('job', 'audio.wav'), true]);
    assert.equal(calls.filter(c => c[0] === 'remove').length, 1);
    assert.equal(calls.filter(c => c[0] === 'write').length, failAt ? 0 : 1);
  }
});
