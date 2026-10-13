'use strict';

const { defaults } = require('../../shared/defaults.cjs');
const { applyCueTiming, normalizeTimingOptions } = require('../../shared/timing.mjs');

function decodeSubtitle(input) {
  if (typeof input === 'string') return input.replace(/^\uFEFF/, '');
  if (!Buffer.isBuffer(input) && !(input instanceof Uint8Array)) throw new Error('字幕内容必须是文本或字节数据');
  const data = Buffer.from(input);
  if (data[0] === 0xff && data[1] === 0xfe) {
    if (data.length % 2) throw new Error('UTF-16 字幕字节长度无效');
    return data.subarray(2).toString('utf16le');
  }
  if (data[0] === 0xfe && data[1] === 0xff) {
    const body = Buffer.from(data.subarray(2));
    if (body.length % 2) throw new Error('UTF-16 字幕字节长度无效');
    return body.swap16().toString('utf16le');
  }
  // BOM-less UTF-16 has recurring zero bytes for the ASCII timestamps.
  const sample = data.subarray(0, Math.min(data.length, 200));
  let even = 0, odd = 0;
  for (let i = 0; i < sample.length; i++) if (sample[i] === 0) i % 2 ? odd++ : even++;
  if (odd > sample.length / 8 && odd > even * 2) {
    if (data.length % 2) throw new Error('UTF-16 字幕字节长度无效');
    return data.toString('utf16le');
  }
  if (even > sample.length / 8 && even > odd * 2) {
    if (data.length % 2) throw new Error('UTF-16 字幕字节长度无效');
    return Buffer.from(data).swap16().toString('utf16le');
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(data).replace(/^\uFEFF/, ''); }
  catch { throw new Error('字幕不是有效的 UTF-8 或 UTF-16 文本，请先转换编码'); }
}

function normalizeCues(cues) {
  if (!Array.isArray(cues)) throw new Error('字幕条目必须是数组');
  return cues.map((cue, i) => {
    if (!cue || cue.start == null || cue.end == null || cue.start === '' || cue.end === '' || !Number.isFinite(Number(cue.start)) || !Number.isFinite(Number(cue.end))) throw new Error(`第 ${i + 1} 条字幕时间无效`);
    const start = Number(cue.start), end = Number(cue.end);
    if (start < 0 || end <= start) throw new Error(`第 ${i + 1} 条字幕结束时间必须晚于非负的开始时间`);
    if (typeof cue.text !== 'string') throw new Error(`第 ${i + 1} 条字幕缺少文本`);
    if (cue.translation != null && typeof cue.translation !== 'string') throw new Error(`第 ${i + 1} 条字幕译文无效`);
    const clean = text => text.replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim();
    const { speechEnd, ...rest } = cue;
    return { ...rest, start, end, ...(typeof speechEnd === 'number' && Number.isFinite(speechEnd) && speechEnd > start && speechEnd <= end ? { speechEnd } : {}), text: clean(cue.text), ...(cue.translation == null ? {} : { translation: clean(cue.translation) }) };
  }).sort((a, b) => a.start - b.start || a.end - b.end).map((cue, i) => ({ ...cue, id: i + 1 }));
}

function normalizeWorkflowCues(cues, style = {}) {
  const normalized = normalizeCues(cues);
  if (!style.stripFinalPeriod) return normalized;
  // Remove a single sentence-final stop per physical line. Ellipses (..., …)
  // and repeated Chinese stops are expressive punctuation and remain intact.
  const strip = text => text.split('\n').map(line => line.replace(/(?<![.。])[.。][\t ]*$/, '')).join('\n');
  return normalized.map(cue => ({ ...cue, text: strip(cue.text), ...(cue.translation == null ? {} : { translation: strip(cue.translation) }) }));
}

function parseSrt(input) {
  const text = decodeSubtitle(input).replace(/\r\n?/g, '\n').trim();
  if (!text) return [];
  const stamp = '(\\d{1,4}):([0-5]\\d):([0-5]\\d)[,.](\\d{1,3})';
  const timing = new RegExp(`^${stamp}\\s*-->\\s*${stamp}(?:\\s+.*)?$`);
  const seconds = (parts, offset) => Number(parts[offset]) * 3600 + Number(parts[offset + 1]) * 60 + Number(parts[offset + 2]) + Number(parts[offset + 3].padEnd(3, '0')) / 1000;
  const cues = text.split(/\n[ \t]*\n+/).map((block, index) => {
    const lines = block.trim().split('\n');
    if (/^\d+$/.test(lines[0].trim())) lines.shift();
    const match = (lines.shift() || '').trim().match(timing);
    if (!match) throw new Error(`第 ${index + 1} 个字幕块的 SRT 时间格式无效`);
    const body = lines.join('\n').trim();
    if (!body) throw new Error(`第 ${index + 1} 个字幕块没有文本`);
    return { start: seconds(match, 1), end: seconds(match, 5), text: body };
  });
  return normalizeCues(cues);
}

function timestamp(seconds, ass = false) {
  let units = Math.max(0, Math.round(seconds * (ass ? 100 : 1000)));
  const scale = ass ? 100 : 1000;
  const fraction = units % scale; units = Math.floor(units / scale);
  const secs = units % 60; units = Math.floor(units / 60);
  const mins = units % 60; const hours = Math.floor(units / 60);
  return `${String(hours).padStart(ass ? 1 : 2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}${ass ? '.' : ','}${String(fraction).padStart(ass ? 2 : 3, '0')}`;
}

function serializeSrt(cues, field = 'text') {
  if (!['text', 'translation', 'bilingual'].includes(field)) throw new Error('不支持的字幕文本字段');
  return normalizeCues(cues).map((cue, i) => {
    const text = field === 'bilingual' ? [cue.text, cue.translation].filter(Boolean).join('\n') : cue[field];
    if (typeof text !== 'string' || !text.trim()) throw new Error(`第 ${i + 1} 条字幕${field === 'translation' ? '缺少译文' : '没有文本'}`);
    const start = Math.round(cue.start * 1000) / 1000;
    const end = Math.max(start + 0.001, Math.round(cue.end * 1000) / 1000);
    return `${i + 1}\n${timestamp(start)} --> ${timestamp(end)}\n${text.replace(/\n\s*\n/g, '\n')}\n`;
  }).join('\n');
}

function encodeSubtitle(text, encoding = 'utf8bom') {
  if (typeof text !== 'string') throw new Error('字幕内容必须是文本');
  text = text.replace(/^\uFEFF/, '');
  if (encoding === 'utf8') return Buffer.from(text, 'utf8');
  if (encoding === 'utf8bom') return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
  if (encoding === 'utf16le') return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  throw new Error('仅支持 UTF-8、UTF-8 BOM 和 UTF-16 LE 编码');
}

function alignTranslation(source, translated) {
  const targets = normalizeCues(translated);
  return normalizeCues(source).map(cue => {
    const matches = targets.filter(target => {
      const overlap = Math.min(cue.end, target.end) - Math.max(cue.start, target.start);
      return overlap > 0 && overlap >= Math.min(cue.end - cue.start, target.end - target.start) * 0.5;
    });
    return { ...cue, translation: matches.map(target => target.text).filter(Boolean).join('\n') };
  });
}

function assColor(hex) {
  if (!/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(hex)) throw new Error(`字幕颜色格式无效：${hex}`);
  // Optional CSS alpha is opacity; ASS alpha is transparency.
  const alpha = hex.length === 9 ? (255 - parseInt(hex.slice(7, 9), 16)).toString(16).padStart(2, '0') : '00';
  return `&H${alpha}${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}`.toUpperCase();
}

function wrapText(text, maxChars) {
  if (!maxChars) return text;
  return text.split('\n').map(line => {
    const chars = Array.from(line); const rows = [];
    while (chars.length > maxChars) {
      let split = maxChars;
      for (let i = maxChars; i >= Math.floor(maxChars * 0.55); i--) if (/\s/.test(chars[i] || '')) { split = i; break; }
      rows.push(chars.splice(0, split).join('').trim());
      while (chars[0] === ' ') chars.shift();
    }
    rows.push(chars.join(''));
    return rows.join('\n');
  }).join('\n');
}

function escapeAss(text) {
  // libass does not treat doubled backslashes as an escape: a literal \\N
  // would still introduce a line break. An invisible word joiner protects the
  // original backslash while preserving its visible glyph.
  return text.replace(/\\/g, '\\\u2060').replace(/{/g, '\\{').replace(/}/g, '\\}').replace(/\r\n?|\n/g, '\\N');
}

function normalizeStyle(inputStyle = {}) {
  if (!inputStyle || typeof inputStyle !== 'object' || Array.isArray(inputStyle)) throw new Error('字幕样式必须是对象');
  const style = { ...defaults.style, ...inputStyle, ...normalizeTimingOptions(inputStyle) };
  const ranges = { fontSize: [4, 500], secondarySize: [4, 500], outline: [0, 30], shadow: [0, 30], marginV: [0, 10000], marginL: [0, 10000], marginR: [0, 10000], spacing: [-20, 100], playResX: [16, 16384], playResY: [16, 16384], maxLineChars: [0, 1000], offset: [-86400, 86400] };
  for (const name of ['secondaryOutline', 'secondaryShadow']) if (style[name] !== undefined) ranges[name] = [0, 30];
  for (const [name, [min, max]] of Object.entries(ranges)) {
    if (style[name] === null || typeof style[name] === 'boolean' || String(style[name]).trim() === '' || !Number.isFinite(Number(style[name])) || Number(style[name]) < min || Number(style[name]) > max) throw new Error(`字幕样式 ${name} 超出有效范围`);
    style[name] = Number(style[name]);
  }
  if (!Number.isInteger(Number(style.maxLineChars))) throw new Error('字幕每行字数必须是整数');
  if (![1, 2, 3, 4, 5, 6, 7, 8, 9].includes(Number(style.alignment)) || ![1, 3].includes(Number(style.borderStyle))) throw new Error('字幕对齐或边框样式无效');
  style.alignment = Number(style.alignment); style.borderStyle = Number(style.borderStyle);
  if (!['source', 'translation', 'bilingual'].includes(style.subtitleMode)) throw new Error('字幕模式无效');
  if (!['utf8', 'utf8bom', 'utf16le'].includes(style.encoding)) throw new Error('字幕编码无效');
  for (const name of ['bold', 'secondaryOnTop', 'stripFinalPeriod', 'secondaryBold']) if (style[name] !== undefined && typeof style[name] !== 'boolean') throw new Error(`字幕样式 ${name} 必须是布尔值`);
  for (const name of ['font', 'secondaryFont']) {
    if (name === 'secondaryFont' && style[name] === undefined) continue;
    if (typeof style[name] !== 'string') throw new Error('字幕字体必须是文本');
    style[name] = style[name].replace(/[,\r\n{}\\]/g, ' ').trim();
    if (!style[name]) throw new Error('字幕字体不能为空');
  }
  for (const name of ['primaryColor', 'secondaryColor', 'outlineColor', 'backColor', 'secondaryOutlineColor']) if (name !== 'secondaryOutlineColor' || style[name] !== undefined) assColor(style[name]);
  return style;
}

function buildAss(cues, inputStyle = {}) {
  const style = normalizeStyle(inputStyle);
  const colors = ['primaryColor', 'secondaryColor', 'outlineColor', 'backColor'].map(name => assColor(style[name]));
  const styleLine = (name, size, color) => {
    const secondary = name === 'Secondary';
    const font = secondary ? style.secondaryFont ?? style.font : style.font;
    const outlineColor = secondary ? assColor(style.secondaryOutlineColor ?? style.outlineColor) : colors[2];
    const bold = secondary ? style.secondaryBold ?? style.bold : style.bold;
    const outline = secondary ? style.secondaryOutline ?? style.outline : style.outline;
    const shadow = secondary ? style.secondaryShadow ?? style.shadow : style.shadow;
    return `Style: ${name},${font},${size},${color},${color},${outlineColor},${colors[3]},${bold ? -1 : 0},0,0,0,100,100,${style.spacing},0,${style.borderStyle},${outline},${shadow},${style.alignment},${style.marginL},${style.marginR},${style.marginV},1`;
  };
  const header = `[Script Info]\nTitle: Subtitle Studio\nScriptType: v4.00+\nPlayResX: ${style.playResX}\nPlayResY: ${style.playResY}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n${styleLine('Primary', style.fontSize, colors[0])}\n${styleLine('Secondary', style.secondarySize, colors[1])}\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  const events = applyCueTiming(normalizeWorkflowCues(cues, style), style).flatMap(cue => {
    if (style.subtitleMode !== 'source' && !cue.translation?.trim()) throw new Error(`第 ${cue.id} 条字幕缺少译文，请先完成翻译或选择原文模式`);
    const start = Math.max(0, cue.start + Number(style.offset));
    const end = cue.end + Number(style.offset);
    if (end <= 0) return [];
    const render = text => escapeAss(wrapText(text || '', Number(style.maxLineChars)));
    let text;
    if (style.subtitleMode === 'translation') {
      if (!cue.translation) throw new Error(`第 ${cue.id} 条字幕缺少译文`);
      text = `{\\rSecondary}${render(cue.translation)}`;
    } else if (style.subtitleMode === 'bilingual' && cue.translation) {
      text = style.secondaryOnTop ? `{\\rSecondary}${render(cue.translation)}\\N{\\rPrimary}${render(cue.text)}` : `${render(cue.text)}\\N{\\rSecondary}${render(cue.translation)}`;
    } else text = render(cue.text);
    if (!text) return [];
    const roundedStart = Math.round(start * 100) / 100;
    const roundedEnd = Math.max(roundedStart + 0.01, Math.round(end * 100) / 100);
    return [`Dialogue: 0,${timestamp(roundedStart, true)},${timestamp(roundedEnd, true)},Primary,,0,0,0,,${text}`];
  });
  return header + events.join('\n') + '\n';
}

module.exports = { parseSrt, serializeSrt, buildAss, encodeSubtitle, normalizeCues, normalizeWorkflowCues, normalizeStyle, alignTranslation, decodeSubtitle, escapeAss };
