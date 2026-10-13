'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { builtinPreset, normalizePreset, normalizeWorkflowCues } = require('../shared/workflow.cjs');
const { buildAss, serializeSrt } = require('../electron/core/subtitles.cjs');

const cue = { start: 0, end: 2, text: 'The value is 3.14.', translation: '数值是 3.14。' };
const preset = settings => ({ version: 1, id: 'custom-test', name: '测试', settings });

test('versioned presets merge defaults, roundtrip and preserve independent settings', () => {
  const result = normalizePreset(preset({ asr: { threads: 4 } }));
  assert.equal(result.settings.asr.threads, 4);
  assert.equal(result.settings.asr.model, 'large-v3-turbo-q5_0');
  assert.deepEqual(result.batch, { recursive: false, continueOnError: true });
  assert.deepEqual(normalizePreset(JSON.parse(JSON.stringify(builtinPreset))), builtinPreset);
  result.settings.asr.model = 'base';
  assert.equal(normalizePreset(preset({})).settings.asr.model, 'large-v3-turbo-q5_0');
});

test('preset rejects unsupported schema, nested keys, enums and invalid scalars', () => {
  for (const value of [null, [], {}, { ...preset({}), version: 2 }, { ...preset({}), id: '../escape' }, { ...preset({}), name: '' }, { ...preset({}), batch: { recursive: 'true' } }, { ...preset({}), apiKey: 'not-allowed' }]) assert.throws(() => normalizePreset(value));
  for (const settings of [
    { asr: { model: 'unknown' } }, { asr: { threads: 0 } }, { asr: { maxChars: 12.5 } }, { asr: { start: Infinity } }, { asr: { language: 'xx' } },
    { translate: { mode: 'invalid' } }, { translate: { model: 'unknown' } }, { translate: { chunkSize: 0 } }, { translate: { polish: 'false' } },
    { style: { secondaryOutline: -1 } }, { style: { secondaryOutlineColor: 'blue' } }, { style: { secondaryFont: '' } }, { style: { secondaryBold: 1 } }, { style: { stripFinalPeriod: 'false' } },
    { style: { alignment: 99 } }, { style: { encoding: 'gbk' } }, { encode: { quality: '20' } }, { encode: { bitrate: null } }, { encode: { codec: 'fake' } }, { encode: { apiKey: 'secret' } }
  ]) assert.throws(() => normalizePreset(preset(settings)), JSON.stringify(settings));
});

test('workflow removes only single line-final stops and preserves decimals, ellipses and questions', () => {
  const original = [{ ...cue, text: 'At 3.14.\nReally?\nYes!\nWait...\nStill…\nEnd.  ', translation: '数值 3.14。\n真的吗？\n好！\n等等……\n等等。。\n完成。' }];
  const result = normalizeWorkflowCues(original, { stripFinalPeriod: true });
  assert.equal(result[0].text, 'At 3.14\nReally?\nYes!\nWait...\nStill…\nEnd');
  assert.equal(result[0].translation, '数值 3.14\n真的吗？\n好！\n等等……\n等等。。\n完成');
  assert.ok(original[0].text.endsWith('End.  '));
  assert.deepEqual(normalizeWorkflowCues(result, { stripFinalPeriod: true }), result);
  assert.equal(normalizeWorkflowCues([cue], { stripFinalPeriod: false })[0].text, cue.text);
  assert.match(serializeSrt(normalizeWorkflowCues([cue], builtinPreset.settings.style)), /The value is 3\.14\n/);
});

test('fansub ASS puts independently styled large Chinese above small English', () => {
  const ass = buildAss([cue], builtinPreset.settings.style);
  const styles = Object.fromEntries(ass.split('\n').filter(line => line.startsWith('Style:')).map(line => { const fields = line.slice(7).split(','); return [fields[0], fields]; }));
  assert.equal(styles.Primary[1], 'Arial');
  assert.equal(styles.Primary[2], '36');
  assert.equal(styles.Primary[5], '&H00191510');
  assert.equal(styles.Primary[16], '1.6');
  assert.equal(styles.Secondary[1], 'Microsoft YaHei');
  assert.equal(styles.Secondary[2], '48');
  assert.equal(styles.Secondary[3], '&H00FFFFFF');
  assert.equal(styles.Secondary[5], '&H00B46428');
  assert.equal(styles.Secondary[16], '2.5');
  assert.ok(ass.includes('{\\rSecondary}数值是 3.14\\N{\\rPrimary}The value is 3.14'));
  assert.ok(buildAss([cue], { ...builtinPreset.settings.style, subtitleMode: 'translation' }).includes('{\\rSecondary}数值是 3.14'));
});

test('legacy styles inherit secondary properties and explicit zero/false remain independent', () => {
  const styles = input => buildAss([cue], input).split('\n').filter(line => line.startsWith('Style:')).map(line => line.slice(7).split(','));
  const [primary, secondary] = styles({ font: 'Arial', outline: 4, shadow: 2, bold: true });
  for (const index of [1, 5, 7, 16, 17]) assert.equal(secondary[index], primary[index]);
  const [, overridden] = styles({ outline: 4, shadow: 2, bold: true, secondaryOutline: 0, secondaryShadow: 0, secondaryBold: false });
  assert.equal(overridden[7], '0'); assert.equal(overridden[16], '0'); assert.equal(overridden[17], '0');
});
