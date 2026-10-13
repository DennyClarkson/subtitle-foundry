'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSrt, serializeSrt, buildAss, encodeSubtitle, normalizeCues, alignTranslation, decodeSubtitle } = require('../electron/core/subtitles.cjs');

const sample = '1\r\n00:00:01,250 --> 00:00:03,500\r\n你好，世界\r\nSecond line\r\n\r\n2\r\n00:01:00.000 --> 00:01:01.001\r\n字幕测试\r\n';
test('SRT parses mixed timestamp punctuation and multiline Unicode, then roundtrips', () => {
  const cues = parseSrt(sample);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].start, 1.25);
  assert.equal(cues[1].end, 61.001);
  assert.equal(cues[0].text, '你好，世界\nSecond line');
  assert.deepEqual(parseSrt(serializeSrt(cues)), cues);
});
test('SRT accepts no index and renumbers sorted cues', () => {
  const cues = parseSrt('4\n00:00:05,000 --> 00:00:06,000\n后\n\n00:00:01,000 --> 00:00:02,000\n前');
  assert.equal(cues[0].text, '前'); assert.equal(cues[1].id, 2);
});
test('UTF8, BOM and both UTF16 byte orders preserve Chinese', () => {
  for (const encoding of ['utf8', 'utf8bom', 'utf16le']) assert.equal(parseSrt(encodeSubtitle(sample, encoding))[0].text, '你好，世界\nSecond line');
  const bigEndian = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(sample, 'utf16le').swap16()]);
  assert.equal(parseSrt(bigEndian)[0].start, 1.25);
  assert.equal(parseSrt(Buffer.from(sample, 'utf16le'))[0].start, 1.25);
  assert.throws(() => decodeSubtitle(Buffer.from([0xc0, 0xff, 0xfe])), /UTF/);
  assert.throws(() => encodeSubtitle(sample, 'gbk'), /编码/);
});
test('invalid blocks, backwards timestamps and nonfinite timing fail visibly', () => {
  assert.throws(() => parseSrt('not a subtitle'), /时间格式/);
  assert.throws(() => parseSrt('1\n00:00:02,000 --> 00:00:01,000\nBad'), /结束时间/);
  assert.throws(() => normalizeCues([{ start: Infinity, end: 4, text: 'x' }]), /时间无效/);
  assert.throws(() => serializeSrt([{ start: 1, end: 2, text: 'x' }], 'translation'), /缺少译文/);
});
test('millisecond rounding carries through minutes without an invalid 1000 field', () => {
  const output = serializeSrt([{ start: 59.9996, end: 60.9996, text: 'x' }]);
  assert.match(output, /00:01:00,000 --> 00:01:01,000/);
});
test('translation alignment follows time overlap rather than source indices', () => {
  const source = [{ start: 1, end: 3, text: 'first' }, { start: 4, end: 6, text: 'second' }, { start: 8, end: 9, text: 'missing' }];
  const targets = [{ start: 4, end: 6, text: '第二' }, { start: 1.1, end: 1.9, text: '第' }, { start: 2, end: 3, text: '一' }];
  const result = alignTranslation(source, targets);
  assert.deepEqual(result.map(cue => cue.translation), ['第\n一', '第二', '']);
});
test('ASS has separate styles, retains commas and protects user override syntax', () => {
  const ass = buildAss([{ start: 1, end: 2, text: 'Hello,{\\bord99} literal \\N\n世界', translation: '你好, friend' }], { maxLineChars: 0 });
  assert.match(ass, /Style: Primary,/); assert.match(ass, /Style: Secondary,/);
  assert.ok(ass.includes('Hello,\\{\\\u2060bord99\\} literal \\\u2060N\\N世界'));
  assert.ok(ass.includes('\\N{\\rSecondary}你好, friend'));
  assert.equal(ass.split('\n').filter(line => line.startsWith('Dialogue:')).length, 1);
});
test('ASS secondary-on-top, offsets and centisecond minimum duration work', () => {
  const ass = buildAss([{ start: 0, end: 0.5, text: 'discard', translation: '丢弃' }, { start: 1, end: 1.001, text: 'source', translation: 'target' }], { offset: -0.75, secondaryOnTop: true });
  assert.equal(ass.split('\n').filter(line => line.startsWith('Dialogue:')).length, 1);
  assert.match(ass, /0:00:00\.25,0:00:00\.26/);
  assert.ok(ass.includes('{\\rSecondary}target\\N{\\rPrimary}source'));
});
test('ASS rejects malformed style data and absent translation in target mode', () => {
  const cue = [{ start: 0, end: 1, text: 'test' }];
  assert.throws(() => buildAss(cue, { primaryColor: 'red\nDialogue:' }), /颜色/);
  assert.throws(() => buildAss(cue, { alignment: 20 }), /对齐/);
  assert.throws(() => buildAss(cue, { subtitleMode: 'translation' }), /缺少译文/);
  assert.throws(() => buildAss(cue), /缺少译文/);
  assert.match(buildAss(cue, { subtitleMode: 'source' }), /Dialogue:/);
});
