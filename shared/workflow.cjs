'use strict';

const { defaults } = require('./defaults.cjs');
const { validateEncode } = require('../electron/core/encoding.cjs');
const { normalizeStyle, normalizeWorkflowCues } = require('../electron/core/subtitles.cjs');

const optionalStyle = { secondaryFont: 'string', secondaryOutlineColor: 'string', secondaryOutline: 'number', secondaryShadow: 'number', secondaryBold: 'boolean' };
const asrLanguages = new Set(('auto en zh de es ru ko fr ja pt tr pl ca nl ar sv it id hi fi vi he uk el ms cs ro da hu ta no th ur hr bg lt la mi ml cy sk te fa lv bn sr az sl kn et mk br eu is hy ne mn bs kk sq sw gl mr pa si km sn yo so af oc ka be tg sd gu am yi lo uz fo ht ps tk nn mt sa lb my bo tl mg as tt haw ln ha ba jw su yue').split(' '));

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`${label}必须是对象`);
  return value;
}
function keys(value, allowed, label) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${label}包含不支持的字段：${key}`);
}
function text(value, label, max, empty = false) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max || /\u0000/.test(value)) throw new Error(`${label}必须是${empty ? '' : '非空'}文本（最多 ${max} 字符）`);
  return value;
}
function number(value, label, min, max, integer = true) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new Error(`${label}必须为 ${min}–${max} 的${integer ? '整数' : '数字'}`);
}
function settingsGroup(raw, name, extra = {}) {
  const input = raw === undefined ? {} : object(raw, `${name} 设置`);
  const template = defaults[name];
  keys(input, [...Object.keys(template), ...Object.keys(extra)], `${name} 设置`);
  for (const [key, value] of Object.entries(input)) {
    const expected = extra[key] || typeof template[key];
    if (typeof value !== expected || (expected === 'number' && !Number.isFinite(value))) throw new Error(`${name}.${key} 类型无效`);
  }
  return { ...template, ...input };
}

function normalizePreset(raw) {
  object(raw, '工作流预设');
  keys(raw, ['version', 'id', 'name', 'description', 'settings', 'batch'], '工作流预设');
  if (raw.version !== 1) throw new Error('不支持的工作流预设版本，当前仅支持 version: 1');
  const id = text(raw.id, '预设 ID', 80);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) throw new Error('预设 ID 仅允许字母、数字、下划线和连字符');
  const name = text(raw.name, '预设名称', 160).trim();
  const description = text(raw.description ?? '', '预设说明', 2000, true);
  const input = raw.settings === undefined ? {} : object(raw.settings, '工作流设置');
  keys(input, ['asr', 'translate', 'style', 'encode'], '工作流设置');
  const asr = settingsGroup(input.asr, 'asr');
  if (!['base', 'large-v3-turbo-q5_0'].includes(asr.model)) throw new Error('未知转写模型');
  if (!asrLanguages.has(asr.language)) throw new Error('转写语言代码无效');
  for (const [key, min, max] of [['threads', 1, 64], ['maxChars', 10, 300], ['audioTrack', 0, 1000]]) number(asr[key], `转写参数 ${key}`, min, max);
  for (const [key, min, max] of [['maxDuration', 1, 30], ['start', 0, 8640000], ['duration', 0, 8640000]]) number(asr[key], `转写参数 ${key}`, min, max, false);
  text(asr.prompt, '转写提示词', 3000, true);
  const translate = settingsGroup(input.translate, 'translate');
  if (!['deepseek-flash', 'deepseek-v4-pro'].includes(translate.model)) throw new Error('不支持的 DeepSeek 模型');
  if (!['source', 'translation', 'bilingual'].includes(translate.mode)) throw new Error('翻译输出模式无效');
  text(translate.sourceLanguage, '原文语言', 100);
  text(translate.targetLanguage, '目标语言', 100);
  text(translate.glossary, '术语表', 100000, true);
  number(translate.chunkSize, '每批字幕条数', 1, 100);
  const style = normalizeStyle(settingsGroup(input.style, 'style', optionalStyle));
  text(style.preset, '样式预设标识', 100);
  const encode = validateEncode(settingsGroup(input.encode, 'encode'));
  text(encode.preset, '编码预设标识', 100);
  const batch = { recursive: false, continueOnError: true, ...object(raw.batch === undefined ? {} : raw.batch, '批处理设置') };
  keys(batch, ['recursive', 'continueOnError'], '批处理设置');
  if (typeof batch.recursive !== 'boolean' || typeof batch.continueOnError !== 'boolean') throw new Error('批处理开关必须是布尔值');
  return { version: 1, id, name, description, settings: { asr, translate, style, encode }, batch };
}

const builtinPreset = normalizePreset({
  version: 1,
  id: 'fansub-en-zh-blue',
  name: '字幕组 · 英译中蓝边双语',
  description: '英语转写、DeepSeek 简体中文翻译；上方大号白字蓝边中文，下方小号白字深色描边英文，去除单个行末句号；按词尾收尾并保留 80 毫秒余量，衔接不超过 200 毫秒的短间隙，CPU H.264 / AAC 输出。',
  settings: {
    asr: { language: 'en', model: 'large-v3-turbo-q5_0' },
    translate: { sourceLanguage: '英语', targetLanguage: '简体中文', mode: 'bilingual' },
    style: {
      preset: 'fansub-en-zh-blue', font: 'Arial', secondaryFont: 'Microsoft YaHei',
      fontSize: 36, secondarySize: 48, primaryColor: '#FFFFFF', secondaryColor: '#FFFFFF',
      outlineColor: '#101519', outline: 1.6, shadow: 0, bold: false,
      secondaryOutlineColor: '#2864B4', secondaryOutline: 2.5, secondaryShadow: 0, secondaryBold: false,
      secondaryOnTop: true, subtitleMode: 'bilingual', stripFinalPeriod: true,
      trimToSpeechEnd: true, endPaddingMs: 80, endTrimMs: 0, fillGapsMs: 200, maxCueDuration: 0,
      marginV: 52, marginL: 70, marginR: 70, maxLineChars: 72, playResX: 1920, playResY: 1080
    },
    encode: { codec: 'libx264', qualityMode: 'quality', quality: 20, audioCodec: 'aac', container: 'mp4' }
  },
  batch: { recursive: false, continueOnError: true }
});

module.exports = { builtinPreset, normalizePreset, normalizeWorkflowCues };
