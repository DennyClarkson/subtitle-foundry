'use strict';

// Real encoder verification. All fixtures, outputs, logs and temporary files
// stay under outputs/codec-smoke. No network or system installation required.
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { buildEncodeArgs, encodingPresets } = require('../electron/core/encoding.cjs');
const { buildAss } = require('../electron/core/subtitles.cjs');
const root = path.resolve(__dirname, '..');
const folder = path.join(root, 'outputs', 'codec-smoke');
const ffmpeg = path.join(root, 'tools', 'ffmpeg', 'ffmpeg.exe');
const ffprobe = path.join(root, 'tools', 'ffmpeg', 'ffprobe.exe');

async function run(executable, args, timeout = 90000) {
  return new Promise(resolve => {
    const child = spawn(executable, args, { cwd: folder, shell: false, windowsHide: true, env: { ...process.env, TEMP: folder, TMP: folder } });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: `${stderr}\n${error.message}`, timedOut }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
  });
}

const cases = [
  ...Object.entries(encodingPresets).map(([name, options]) => ({ name: `preset-${name}`, options })),
  { name: 'svt-av1-8bit', options: { codec: 'libsvtav1' } },
  { name: 'aom-av1-8bit', options: { codec: 'libaom-av1', speed: '8' } },
  { name: 'x265-10bit', options: { codec: 'libx265', pixelFormat: 'yuv420p10le' } },
  { name: 'svt-av1-10bit', options: { codec: 'libsvtav1', pixelFormat: 'yuv420p10le', profile: 'main' } },
  { name: 'vp9-10bit', options: { ...encodingPresets.web, pixelFormat: 'yuv420p10le' } },
  { name: 'vp9-10bit-profile-main', options: { ...encodingPresets.web, pixelFormat: 'yuv420p10le', profile: 'main' } },
  { name: 'prores-4444', options: { ...encodingPresets.archive, profile: '4', pixelFormat: 'yuv444p10le' } },
  { name: 'x264-bitrate-transform', options: { qualityMode: 'bitrate', bitrate: 800, maxrate: 1200, bufsize: 2400, resolution: '320x240', fps: '30', deinterlace: true, audioSampleRate: '48000', audioChannels: '2', profile: 'high', tune: 'film' } },
  { name: 'x264-baseline', options: { profile: 'baseline' } },
  { name: 'x264-copy-audio', options: { audioCodec: 'copy' } },
  { name: 'x264-no-audio', options: { audioCodec: 'none' } },
  { name: 'x264-bt709', options: { colorMode: 'bt709' } },
  { name: 'x264-hdr-tonemap', hdr: true, options: { colorMode: 'sdr' } },
  ...['h264', 'hevc', 'av1'].flatMap(family => [
    { name: `${family}-nvenc`, options: { codec: `${family}_nvenc` } },
    { name: `${family}-nvenc-bitrate`, options: { codec: `${family}_nvenc`, qualityMode: 'bitrate', bitrate: 800, maxrate: 1200, bufsize: 2400, speed: 'p5' } },
    ...(family === 'h264' ? [] : [{ name: `${family}-nvenc-10bit`, options: { codec: `${family}_nvenc`, pixelFormat: 'p010le' } }]),
    { name: `${family}-qsv`, hardwareProbe: true, options: { codec: `${family}_qsv` } },
    ...(family === 'h264' ? [] : [{ name: `${family}-qsv-10bit`, hardwareProbe: true, options: { codec: `${family}_qsv`, pixelFormat: 'p010le' } }]),
    { name: `${family}-amf`, hardwareProbe: true, options: { codec: `${family}_amf` } },
  ]),
];

async function main() {
  await fs.mkdir(folder, { recursive: true });
  const source = path.join(folder, 'source.mp4');
  const hdrSource = path.join(folder, 'source-hdr.mkv');
  const fixtureArgs = ['-nostdin', '-hide_banner', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=0.5', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.5', '-shortest'];
  const fixture = await run(ffmpeg, [...fixtureArgs, '-vf', 'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-c:a', 'aac', source]);
  if (fixture.code !== 0) throw new Error(fixture.stderr);
  const hdrFixture = await run(ffmpeg, [...fixtureArgs, '-vf', 'format=yuv420p10le,setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc', '-c:v', 'ffv1', '-c:a', 'pcm_s16le', hdrSource]);
  if (hdrFixture.code !== 0) throw new Error(hdrFixture.stderr);
  await fs.writeFile(path.join(folder, 'subtitle.ass'), buildAss([{ id: 1, start: 0, end: 0.5, text: 'Encoder smoke test', translation: '编码器测试 · 双语字幕' }], { playResX: 640, playResY: 360, fontSize: 26, secondarySize: 22, marginV: 20, marginL: 20, marginR: 20 }));
  const results = [];
  const selected = process.argv[2] ? cases.filter(item => item.name.includes(process.argv[2])) : cases;
  for (const item of selected) {
    const output = path.join(folder, `${item.name}.${item.options.container || 'mp4'}`);
    let args, result;
    const started = Date.now();
    try {
      args = buildEncodeArgs({ input: item.hdr ? hdrSource : source, output, assPath: 'subtitle.ass', options: item.options, duration: 0.5 });
      result = await run(ffmpeg, args);
    } catch (error) { result = { code: -2, stdout: '', stderr: error.stack }; }
    const record = { name: item.name, options: item.options, expectedHardwareProbe: !!item.hardwareProbe, output, elapsedMs: Date.now() - started, exitCode: result.code, args, success: false };
    await fs.writeFile(path.join(folder, `${item.name}.log`), `${JSON.stringify(args)}\n\n${result.stderr}\n\n${result.stdout}`);
    if (result.code === 0) {
      const probe = await run(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-count_frames', '-of', 'json', output]);
      try { record.probe = JSON.parse(probe.stdout); } catch { record.probeError = probe.stderr; }
      const decode = await run(ffmpeg, ['-nostdin', '-hide_banner', '-v', 'error', '-i', output, '-f', 'null', '-']);
      record.decodeExitCode = decode.code;
      const video = record.probe?.streams?.find(stream => stream.codec_type === 'video');
      const audio = record.probe?.streams?.find(stream => stream.codec_type === 'audio');
      record.success = probe.code === 0 && decode.code === 0 && Number(video?.nb_read_frames) > 0 && (item.options.audioCodec === 'none' ? !audio : !!audio);
      record.actual = video ? { codec: video.codec_name, profile: video.profile, pixelFormat: video.pix_fmt, width: video.width, height: video.height, frames: video.nb_read_frames, audio: audio?.codec_name, colorTransfer: video.color_transfer } : null;
      if (decode.code !== 0) record.error = decode.stderr;
    } else record.error = result.stderr.split('\n').filter(line => /error|failed|cannot|not support|unsupported|invalid|device|available/i.test(line)).slice(-8).join('\n');
    results.push(record);
    console.log(`${record.success ? 'PASS' : item.hardwareProbe ? 'UNAVAILABLE' : 'FAIL'} ${item.name}: ${JSON.stringify(record.actual || record.error)}`);
    await fs.writeFile(path.join(folder, process.argv[2] ? `report-${process.argv[2]}.json` : 'report.json'), JSON.stringify({ date: new Date().toISOString(), ffmpeg, results }, null, 2));
  }
  if (results.some(item => !item.success && !item.expectedHardwareProbe)) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
