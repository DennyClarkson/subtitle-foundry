'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildEncodeArgs, validateEncode, parseProbe, encoderCatalog, encodingPresets } = require('../electron/core/encoding.cjs');

const build = options => buildEncodeArgs({ input: 'D:\\媒体\\video & more.mp4', output: `D:\\exports\\final.${options?.container || 'mp4'}`, assPath: 'subtitle.ass', options });
const flag = (args, name) => args[args.indexOf(name) + 1];
test('H264 builds shell-free args, maps audio ordinal and retains literal source filename', () => {
  const args = build({ audioTrack: 1 });
  assert.equal(flag(args, '-i'), 'D:\\媒体\\video & more.mp4');
  assert.ok(args.includes('0:a:1?'));
  assert.equal(flag(args, '-crf'), '20');
  assert.match(flag(args, '-vf'), /ass=subtitle\.ass/);
  assert.equal(flag(args, '-movflags'), '+faststart');
});
test('hardware rate controls use their actual encoder options', () => {
  const nvenc = build({ codec: 'hevc_nvenc', speed: 'slow' });
  assert.equal(flag(nvenc, '-preset'), 'p5'); assert.equal(flag(nvenc, '-cq'), '20'); assert.equal(flag(nvenc, '-tag:v'), 'hvc1');
  const qsv = build({ codec: 'h264_qsv' }); assert.equal(flag(qsv, '-global_quality'), '20'); assert.ok(!qsv.includes('-crf'));
  const amf = build({ codec: 'h264_amf' }); assert.equal(flag(amf, '-rc'), 'cqp'); assert.equal(flag(amf, '-qp_i'), '20'); assert.equal(flag(amf, '-quality'), 'balanced');
});
test('software AV1, VP9 and ProRes get distinct quality and speed flags', () => {
  const av1 = build({ codec: 'libsvtav1' }); assert.equal(flag(av1, '-preset'), '7');
  const vp9 = build(encodingPresets.web); assert.equal(flag(vp9, '-cpu-used'), '4'); assert.equal(flag(vp9, '-b:v'), '0'); assert.ok(!vp9.includes('-movflags'));
  const prores = build(encodingPresets.archive); assert.equal(flag(prores, '-qscale:v'), '9'); assert.equal(flag(prores, '-profile:v'), '3'); assert.ok(!prores.includes('-b:a'));
});
test('bitrate mode and video transformations carry validated values', () => {
  const args = build({ qualityMode: 'bitrate', bitrate: 4000, maxrate: 6000, bufsize: 12000, resolution: '1280x720', fps: '30000/1001', deinterlace: true, audioCodec: 'none' });
  assert.equal(flag(args, '-b:v'), '4000k'); assert.equal(flag(args, '-maxrate'), '6000k');
  assert.ok(args.includes('-an')); assert.ok(!args.includes('-c:a'));
  const vf = flag(args, '-vf'); assert.match(vf, /bwdif=.*scale=1280:720.*pad=1280:720.*fps=30000\/1001.*ass=/);
});
test('invalid container and codec/audio combinations fail before spawning FFmpeg', () => {
  for (const options of [{ container: 'webm', codec: 'libx264' }, { container: 'mp4', codec: 'prores_ks' }, { container: 'webm', codec: 'libvpx-vp9', audioCodec: 'aac' }, { audioCodec: 'pcm_s16le' }, { audioCodec: 'copy', audioChannels: '2' }]) assert.throws(() => validateEncode(options));
});
test('untrusted expressions, paths and incompatible profiles are rejected', () => {
  for (const options of [{ resolution: '1920:1080,drawtext=oops' }, { fps: '1/0' }, { bitrate: -1 }, { maxrate: 2000 }, { codec: 'unknown' }, { codec: 'libx265', profile: 'main10' }, { codec: 'libsvtav1', speed: '99' }, { quality: NaN }]) assert.throws(() => validateEncode(options));
  assert.throws(() => buildEncodeArgs({ input: 'x', output: 'x.mp4', assPath: '../subtitle.ass' }), /安全/);
  assert.throws(() => buildEncodeArgs({ input: 'x', output: 'x.webm', assPath: 'subtitle.ass' }), /扩展名/);
});
test('preview is short and preserves original duration bound', () => {
  const args = buildEncodeArgs({ input: 'x', output: 'x.mp4', assPath: 'subtitle.ass', preview: true, duration: 2.5 });
  assert.equal(flag(args, '-t'), '2.5');
});
test('probe excludes cover art, accounts for rotation and uses audio stream ordinal', () => {
  const result = parseProbe({ streams: [{ codec_type: 'video', disposition: { attached_pic: 1 }, width: 100, height: 100 }, { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '30000/1001', side_data_list: [{ rotation: -90 }] }, { index: 3, codec_type: 'audio', codec_name: 'aac', tags: { language: 'eng' } }, { index: 5, codec_type: 'audio', codec_name: 'aac', tags: { title: '中文' } }], format: { duration: '12.5', size: '1024' } }, 'D:\\foo\\video.mp4');
  assert.equal(result.width, 1080); assert.equal(result.height, 1920); assert.equal(result.name, 'video.mp4');
  assert.deepEqual(result.audioTracks.map(track => track.index), [0, 1]); assert.equal(result.duration, 12.5);
  assert.throws(() => parseProbe('{bad', 'x'), /JSON/);
  assert.throws(() => parseProbe({ streams: [] }, 'x'), /视频轨道/);
});
test('each advertised encoder validates a conservative compatible configuration', () => {
  for (const encoder of encoderCatalog) validateEncode(encoder.family === 'prores' ? encodingPresets.archive : { codec: encoder.id });
});
test('HDR-to-SDR runs linear float tone mapping before ASS and removes HDR metadata', () => {
  const args = build({ colorMode: 'sdr' });
  const vf = flag(args, '-vf');
  assert.match(vf, /zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv/);
  assert.ok(vf.indexOf('tonemap=') < vf.indexOf('ass='));
  assert.match(vf, /sidedata=mode=delete:type=MASTERING_DISPLAY_METADATA/);
  assert.equal(flag(args, '-color_trc'), 'bt709');
  const source = build({ colorMode: 'source' });
  assert.ok(!source.includes('-color_trc'));
  assert.ok(!flag(source, '-vf').includes('tonemap'));
});
test('hardware quality bounds and 10-bit profile inference are explicit', () => {
  assert.throws(() => validateEncode({ codec: 'av1_nvenc', quality: 63 }), /quality/);
  assert.equal(validateEncode({ codec: 'libsvtav1', quality: 63 }).quality, 63);
  assert.equal(validateEncode({ codec: 'hevc_nvenc', pixelFormat: 'p010le' }).profile, 'main10');
  assert.equal(validateEncode({ codec: 'libx265', pixelFormat: 'yuv420p10le' }).profile, 'main10');
  assert.equal(validateEncode({ codec: 'h264_qsv' }).pixelFormat, 'nv12');
  assert.equal(flag(build({ codec: 'av1_qsv', profile: 'main', pixelFormat: 'p010le' }), '-profile:v'), 'main');
});
test('VP9 profile follows bit depth and rejects incompatible explicit profiles', () => {
  assert.equal(flag(build({ ...encodingPresets.web, pixelFormat: 'yuv420p10le', profile: 'main' }), '-profile:v'), '2');
  assert.equal(flag(build(encodingPresets.web), '-profile:v'), '0');
  assert.throws(() => validateEncode({ ...encodingPresets.web, pixelFormat: 'yuv420p10le', profile: '0' }), /Profile 2/);
  assert.throws(() => validateEncode({ ...encodingPresets.web, profile: '2' }), /10-bit/);
});
