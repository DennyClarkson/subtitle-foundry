'use strict';

const path = require('node:path');
const { defaults } = require('../../shared/defaults.cjs');

const encoderCatalog = [
  ['libx264', 'H.264 · CPU', 'h264', 'software'], ['libx265', 'H.265 / HEVC · CPU', 'hevc', 'software'],
  ['libsvtav1', 'AV1 · SVT CPU', 'av1', 'software'], ['libaom-av1', 'AV1 · AOM CPU', 'av1', 'software'],
  ['libvpx-vp9', 'VP9 · CPU', 'vp9', 'software'], ['prores_ks', 'ProRes · CPU', 'prores', 'software'],
  ['h264_nvenc', 'H.264 · NVIDIA', 'h264', 'nvenc'], ['hevc_nvenc', 'H.265 · NVIDIA', 'hevc', 'nvenc'], ['av1_nvenc', 'AV1 · NVIDIA', 'av1', 'nvenc'],
  ['h264_qsv', 'H.264 · Intel QSV', 'h264', 'qsv'], ['hevc_qsv', 'H.265 · Intel QSV', 'hevc', 'qsv'], ['av1_qsv', 'AV1 · Intel QSV', 'av1', 'qsv'],
  ['h264_amf', 'H.264 · AMD AMF', 'h264', 'amf'], ['hevc_amf', 'H.265 · AMD AMF', 'hevc', 'amf'], ['av1_amf', 'AV1 · AMD AMF', 'av1', 'amf'],
].map(([id, label, family, kind]) => ({ id, codec: id, label, family, kind, containers: family === 'prores' ? ['mov', 'mkv'] : ['av1', 'vp9'].includes(family) ? ['mp4', 'mkv', 'webm', 'mov'] : ['mp4', 'mkv', 'mov'] }));

const encodingPresets = {
  balanced: { ...defaults.encode },
  quality: { ...defaults.encode, preset: 'quality', quality: 17, speed: 'slow' },
  compact: { ...defaults.encode, preset: 'compact', codec: 'libx265', quality: 25, speed: 'medium' },
  web: { ...defaults.encode, preset: 'web', container: 'webm', codec: 'libvpx-vp9', quality: 32, speed: '4', audioCodec: 'libopus', faststart: false },
  archive: { ...defaults.encode, preset: 'archive', container: 'mov', codec: 'prores_ks', quality: 9, pixelFormat: 'yuv422p10le', profile: '3', audioCodec: 'pcm_s24le', faststart: false },
};
const x26xSpeeds = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'];

function validateEncode(input = {}) {
  const options = { ...defaults.encode, ...input };
  const encoder = encoderCatalog.find(item => item.id === options.codec);
  if (!encoder) throw new Error('不支持的编码器，请选择列表中的视频编码器');
  if (!encoder.containers.includes(options.container)) throw new Error(`${encoder.label} 不支持 ${options.container} 容器`);
  if (!['quality', 'bitrate'].includes(options.qualityMode)) throw new Error('质量控制模式无效');
  const maxQuality = encoder.kind !== 'software' ? 51 : encoder.family === 'av1' || encoder.family === 'vp9' ? 63 : encoder.family === 'prores' ? 31 : 51;
  const ranges = { quality: [0, maxQuality], bitrate: [1, 1000000], maxrate: [0, 1000000], bufsize: [0, 2000000], audioBitrate: [8, 1536], audioTrack: [0, 1000], threads: [0, 256] };
  for (const [key, [min, max]] of Object.entries(ranges)) {
    const number = Number(options[key]);
    if (!Number.isFinite(number) || number < min || number > max || !Number.isInteger(number)) throw new Error(`编码参数 ${key} 必须为 ${min}–${max} 的整数`);
    options[key] = number;
  }
  if (encoder.family === 'prores' && (options.qualityMode === 'bitrate' || options.quality < 1)) throw new Error('ProRes 使用 1–31 的质量值，不支持此界面的目标码率模式');
  if (options.maxrate && options.qualityMode === 'bitrate' && options.maxrate < options.bitrate) throw new Error('最大码率不能低于目标码率');
  if ((options.maxrate > 0) !== (options.bufsize > 0)) throw new Error('最大码率和缓冲区大小必须同时设置');
  const audioCodecs = ['aac', 'copy', 'none', 'libopus', 'opus', 'libvorbis', 'vorbis', 'libmp3lame', 'mp3', 'ac3', 'flac', 'pcm_s16le', 'pcm_s24le'];
  if (!audioCodecs.includes(options.audioCodec)) throw new Error('不支持的音频编码器');
  options.audioCodec = ({ opus: 'libopus', vorbis: 'libvorbis', mp3: 'libmp3lame' })[options.audioCodec] || options.audioCodec;
  if (options.container === 'webm' && !['libopus', 'libvorbis', 'none'].includes(options.audioCodec)) throw new Error('WebM 请选择 Opus、Vorbis 或无音频；音频复制的兼容性无法预先保证');
  if (['mp4', 'mov'].includes(options.container) && ['libvorbis', 'flac'].includes(options.audioCodec)) throw new Error('此音频编码请使用 MKV 容器');
  if (options.container === 'mp4' && options.audioCodec.startsWith('pcm_')) throw new Error('PCM 音频请使用 MOV 或 MKV 容器');
  for (const key of ['audioSampleRate', 'audioChannels']) options[key] = String(options[key]);
  if (!['source', '22050', '24000', '32000', '44100', '48000', '88200', '96000', '192000'].includes(options.audioSampleRate)) throw new Error('音频采样率无效');
  if (!['source', '1', '2', '6', '8'].includes(options.audioChannels)) throw new Error('音频声道数无效');
  if (options.audioCodec === 'copy' && (options.audioSampleRate !== 'source' || options.audioChannels !== 'source')) throw new Error('复制音频时不能改变采样率或声道数');
  if (options.audioCodec === 'libopus' && !['source', '24000', '48000'].includes(options.audioSampleRate)) throw new Error('Opus 请选择源采样率、24000 或 48000 Hz');
  options.resolution = String(options.resolution);
  if (options.resolution !== 'source') {
    const size = /^(\d{2,5})[x:](\d{2,5})$/.exec(options.resolution);
    if (!size || size.slice(1).some(n => Number(n) < 16 || Number(n) > 16384 || Number(n) % 2)) throw new Error('输出分辨率须为偶数宽高，例如 1920x1080');
    options.resolution = `${Number(size[1])}x${Number(size[2])}`;
  }
  options.fps = String(options.fps);
  if (options.fps !== 'source' && (!/^\d+(?:\.\d+|\/\d+)?$/.test(options.fps) || !(parseRate(options.fps) >= 1 && parseRate(options.fps) <= 240))) throw new Error('帧率必须为 1–240，可使用 30000/1001');
  const formats = encoder.family === 'prores' ? ['yuv422p10le', 'yuv444p10le', 'yuva444p10le'] : encoder.family === 'h264' ? ['yuv420p', 'nv12'] : encoder.kind === 'software' ? ['yuv420p', 'yuv420p10le'] : ['yuv420p', 'nv12', 'p010le'];
  if (!formats.includes(options.pixelFormat)) throw new Error(`${encoder.label} 的像素格式请选择 ${formats.join(' / ')}`);
  // QSV exposes NV12 for 8-bit input, not planar YUV420P.
  if (encoder.kind === 'qsv' && options.pixelFormat === 'yuv420p') options.pixelFormat = 'nv12';
  const profiles = encoder.family === 'h264' ? ['auto', 'baseline', 'main', 'high'] : encoder.family === 'hevc' ? ['auto', 'main', 'main10'] : encoder.family === 'prores' ? ['auto', '0', '1', '2', '3', '4', '5'] : encoder.family === 'vp9' ? ['auto', 'main', '0', '2'] : ['auto', 'main', '0'];
  if (!profiles.includes(String(options.profile))) throw new Error(`${encoder.label} 的 Profile 无效`);
  if (options.profile === 'main10' && !['p010le', 'yuv420p10le'].includes(options.pixelFormat)) throw new Error('Main10 Profile 需要 10-bit 像素格式');
  if (encoder.family === 'hevc' && options.profile === 'main' && ['p010le', 'yuv420p10le'].includes(options.pixelFormat)) throw new Error('10-bit HEVC 像素格式请选择 Main10 或自动 Profile');
  if (encoder.family === 'hevc' && options.profile === 'auto' && ['p010le', 'yuv420p10le'].includes(options.pixelFormat)) options.profile = 'main10';
  if (encoder.family === 'vp9') {
    const tenBit = options.pixelFormat === 'yuv420p10le';
    if (String(options.profile) === '0' && tenBit) throw new Error('VP9 10-bit 需要 Profile 2 或自动 Profile');
    if (String(options.profile) === '2' && !tenBit) throw new Error('VP9 Profile 2 需要 10-bit 像素格式');
    if (['auto', 'main'].includes(options.profile)) options.profile = tenBit ? '2' : '0';
  }
  if (encoder.family === 'prores' && ['yuv444p10le', 'yuva444p10le'].includes(options.pixelFormat) && !['4', '5'].includes(String(options.profile))) throw new Error('ProRes 4:4:4 像素格式需要 Profile 4 或 5');
  options.speed = String(options.speed);
  const namedSpeed = options.speed === 'auto' || x26xSpeeds.includes(options.speed);
  if (encoder.id === 'libx264' || encoder.id === 'libx265' || encoder.kind === 'qsv') {
    if (!namedSpeed) throw new Error('当前编码器的速度预设无效');
  } else if (encoder.kind === 'nvenc') {
    if (!namedSpeed && !/^p[1-7]$/.test(options.speed)) throw new Error('NVENC 速度请选择 p1–p7 或常用速度名称');
  } else if (encoder.kind === 'amf') {
    if (!namedSpeed && !['speed', 'balanced', 'quality'].includes(options.speed)) throw new Error('AMF 速度预设无效');
  } else if (encoder.family !== 'prores') {
    const max = encoder.id === 'libsvtav1' ? 13 : encoder.id === 'libvpx-vp9' ? 5 : 8;
    if (!namedSpeed && (!/^\d+$/.test(options.speed) || Number(options.speed) > max)) throw new Error(`当前编码器速度须为 0–${max} 或常用速度名称`);
  }
  if (!['auto', 'film', 'animation', 'grain', 'stillimage', 'fastdecode', 'zerolatency', 'psnr', 'ssim'].includes(options.tune)) throw new Error('Tune 参数无效');
  if (options.tune !== 'auto' && !['libx264', 'libx265'].includes(encoder.id)) throw new Error('当前 Tune 选项仅支持 CPU H.264/H.265 编码器');
  if (encoder.id === 'libx265' && ['film', 'animation', 'stillimage'].includes(options.tune)) throw new Error('H.265 不支持所选 Tune 参数');
  if (!['source', 'bt709', 'sdr', 'bt2020', 'hdr10'].includes(options.colorMode)) throw new Error('色彩模式无效');
  if (['bt2020', 'hdr10'].includes(options.colorMode)) throw new Error('HDR 转换需要经过验证的色调映射流程；请保留源色彩或使用 SDR 输出');
  if (typeof options.faststart !== 'boolean' || typeof options.deinterlace !== 'boolean') throw new Error('编码开关参数无效');
  return options;
}

function parseRate(value) {
  const [numerator, denominator = 1] = String(value || '0').split('/').map(Number);
  return Number.isFinite(numerator / denominator) ? numerator / denominator : 0;
}

function buildEncodeArgs({ input, output, assPath, options: rawOptions, duration, preview = false }) {
  const options = validateEncode(rawOptions);
  if (typeof input !== 'string' || !input || typeof output !== 'string' || !output) throw new Error('缺少输入或输出文件路径');
  if (typeof assPath !== 'string' || !/^[A-Za-z0-9_-]+\.ass$/.test(assPath)) throw new Error('ASS 文件必须使用任务目录内的安全相对文件名');
  if (path.extname(output).toLowerCase() !== `.${options.container}`) throw new Error('输出文件扩展名与容器不一致');
  const encoder = encoderCatalog.find(item => item.id === options.codec);
  const args = ['-nostdin', '-hide_banner', '-y', '-i', input];
  if (preview) args.push('-t', String(Math.max(0.1, Math.min(12, Number(duration) > 0 ? Number(duration) : 12))));
  args.push('-map', '0:v:0');
  if (options.audioCodec !== 'none') args.push('-map', `0:a:${options.audioTrack}?`);
  else args.push('-an');
  const filters = [];
  if (options.deinterlace) filters.push('bwdif=mode=send_frame:parity=auto:deint=all');
  if (options.resolution !== 'source') {
    const [w, h] = options.resolution.split('x');
    filters.push(`scale=${w}:${h}:force_original_aspect_ratio=decrease:force_divisible_by=2`, `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`);
  } else filters.push('pad=ceil(iw/2)*2:ceil(ih/2)*2');
  if (options.fps !== 'source') filters.push(`fps=${options.fps}`);
  if (options.colorMode === 'sdr') filters.push('zscale=t=linear:npl=100', 'format=gbrpf32le', 'zscale=p=bt709', 'tonemap=tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=tv', `format=${options.pixelFormat}`, 'sidedata=mode=delete:type=MASTERING_DISPLAY_METADATA', 'sidedata=mode=delete:type=CONTENT_LIGHT_LEVEL');
  else if (options.colorMode === 'bt709') filters.push('colorspace=all=bt709');
  filters.push(`ass=${assPath}`);
  args.push('-vf', filters.join(','), '-c:v', options.codec, '-pix_fmt', options.pixelFormat);
  if (options.qualityMode === 'bitrate') args.push('-b:v', `${options.bitrate}k`);
  else if (encoder.kind === 'nvenc') args.push('-rc', 'vbr', '-cq', String(options.quality), '-b:v', '0');
  else if (encoder.kind === 'qsv') args.push('-global_quality', String(options.quality));
  else if (encoder.kind === 'amf') args.push('-rc', 'cqp', '-qp_i', String(options.quality), '-qp_p', String(options.quality));
  else if (encoder.family === 'prores') args.push('-qscale:v', String(options.quality));
  else {
    args.push('-crf', String(options.quality));
    if (['libvpx-vp9', 'libaom-av1'].includes(encoder.id)) args.push('-b:v', '0');
  }
  if (options.maxrate) args.push('-maxrate', `${options.maxrate}k`, '-bufsize', `${options.bufsize}k`);
  const speed = options.speed === 'auto' ? 'medium' : options.speed;
  if (['libx264', 'libx265'].includes(encoder.id) || encoder.kind === 'qsv') args.push('-preset', speed);
  else if (encoder.kind === 'nvenc') args.push('-preset', /^p[1-7]$/.test(speed) ? speed : ({ ultrafast: 'p1', superfast: 'p1', veryfast: 'p2', faster: 'p3', fast: 'p3', medium: 'p4', slow: 'p5', slower: 'p6', veryslow: 'p7' })[speed]);
  else if (encoder.kind === 'amf') args.push('-quality', ['speed', 'balanced', 'quality'].includes(speed) ? speed : /slow/.test(speed) ? 'quality' : /fast/.test(speed) ? 'speed' : 'balanced');
  else if (encoder.family !== 'prores') {
    const numeric = /^\d+$/.test(speed) ? speed : encoder.id === 'libsvtav1' ? (/slow/.test(speed) ? '4' : /fast/.test(speed) ? '10' : '7') : (/slow/.test(speed) ? '1' : /fast/.test(speed) ? '5' : '3');
    args.push(encoder.id === 'libsvtav1' ? '-preset' : '-cpu-used', numeric);
    if (encoder.id === 'libvpx-vp9') args.push('-row-mt', '1');
  }
  if (options.profile !== 'auto') {
    let profile = String(options.profile);
    if (encoder.family === 'av1') profile = ['qsv', 'amf'].includes(encoder.kind) ? 'main' : '0';
    args.push('-profile:v', profile);
  }
  else if (encoder.family === 'prores') args.push('-profile:v', '3');
  if (options.tune !== 'auto') args.push('-tune', options.tune);
  if (encoder.family === 'hevc' && ['mp4', 'mov'].includes(options.container)) args.push('-tag:v', 'hvc1');
  if (options.threads) args.push('-threads', String(options.threads));
  if (options.colorMode === 'sdr' || options.colorMode === 'bt709') args.push('-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709');
  if (options.audioCodec !== 'none') {
    args.push('-c:a', options.audioCodec);
    if (options.audioCodec !== 'copy') {
      if (!options.audioCodec.startsWith('pcm_') && options.audioCodec !== 'flac') args.push('-b:a', `${options.audioBitrate}k`);
      if (options.audioSampleRate !== 'source') args.push('-ar', options.audioSampleRate);
      if (options.audioChannels !== 'source') args.push('-ac', options.audioChannels);
    }
  }
  if (options.faststart && ['mp4', 'mov'].includes(options.container)) args.push('-movflags', '+faststart');
  args.push('-sn', '-dn', '-progress', 'pipe:1', '-nostats', output);
  return args;
}

function parseProbe(input, filePath) {
  let data;
  try { data = typeof input === 'string' ? JSON.parse(input) : input; } catch { throw new Error('FFprobe 返回了无效 JSON'); }
  if (!data || !Array.isArray(data.streams)) throw new Error('无法读取媒体流信息');
  const video = data.streams.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
  if (!video) throw new Error('所选文件没有可用的视频轨道');
  const audio = data.streams.filter(stream => stream.codec_type === 'audio');
  const positive = value => Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
  const duration = positive(data.format?.duration) || positive(video.duration);
  let width = positive(video.width), height = positive(video.height);
  const rotation = Number(video.side_data_list?.find(item => item.rotation != null)?.rotation ?? video.tags?.rotate ?? 0);
  if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];
  if (!width || !height) throw new Error('无法读取视频分辨率');
  return { path: filePath, name: path.win32.basename(filePath), duration, width, height, fps: parseRate(video.avg_frame_rate) || parseRate(video.r_frame_rate), codec: video.codec_name || '', audioCodec: audio[0]?.codec_name || '', audioTracks: audio.map((stream, index) => ({ index, language: stream.tags?.language || 'und', title: stream.tags?.title || `音轨 ${index + 1}` })), size: positive(data.format?.size), url: '' };
}

module.exports = { buildEncodeArgs, validateEncode, parseProbe, encoderCatalog, encodingPresets, encoders: encoderCatalog, presets: encodingPresets };
