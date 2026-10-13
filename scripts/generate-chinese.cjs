'use strict';

// Run from the project root: node scripts/generate-chinese.cjs
// Optional MINIMAX_ENDPOINT selects the account's documented region; never contains a key.
const fs = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const text = '欢迎使用双语字幕工作台。今天，我们用一段简短的中文语音，测试自动识别、智能翻译和字幕导出。你可以调整字体、颜色和位置，最后把字幕合成到视频中。';
const allowedEndpoints = new Set([
  'https://api.minimax.cn/v1/t2a_v2', 'https://api-bj.minimaxi.com/v1/t2a_v2',
  'https://api.minimax.io/v1/t2a_v2', 'https://api-uw.minimax.io/v1/t2a_v2'
]);

async function main() {
  const envName = Object.keys(process.env).find(name => name.toLowerCase() === 'minimax');
  const key = envName ? process.env[envName]?.trim() : '';
  if (!key) throw new Error('MINIMAX 环境变量未设置');
  const endpoint = process.env.MINIMAX_ENDPOINT || 'https://api.minimax.cn/v1/t2a_v2';
  if (!allowedEndpoints.has(endpoint)) throw new Error('MINIMAX_ENDPOINT 必须为官方受支持的区域地址');
  const output = path.join(root, 'outputs', 'test-chinese');
  const audio = path.join(output, 'chinese-test.mp3');
  try { await fs.access(audio); console.log('已有测试音频，跳过生成：' + audio); return; } catch {}
  const body = {
    model: 'speech-2.8-hd', text, stream: false, language_boost: 'Chinese', output_format: 'hex',
    voice_setting: { voice_id: 'male-qn-qingse', speed: 1.05, vol: 1, pitch: 0 },
    audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
    subtitle_enable: false
  };
  let response;
  try {
    response = await fetch(endpoint, { method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
  } catch { throw new Error('MiniMax 网络请求失败或超时；未自动重试以避免重复计费'); }
  if (!response.ok) throw new Error(`MiniMax HTTP ${response.status}；请检查账户区域、密钥和余额`);
  let data;
  try { data = await response.json(); } catch { throw new Error('MiniMax 响应 JSON 无效'); }
  if (data?.base_resp?.status_code !== 0) {
    const code = Number(data?.base_resp?.status_code);
    if (code === 1008) throw new Error('MiniMax 账户余额不足（1008）；请充值后重新运行，未生成音频');
    if (code === 1004) throw new Error('MiniMax 鉴权失败（1004）；请检查密钥及账户区域');
    throw new Error(`MiniMax 业务错误 ${code || 'unknown'}；请检查账户区域、密钥和余额`);
  }
  const hex = data?.data?.audio;
  if (data?.data?.status !== 2 || typeof hex !== 'string' || !hex.length || hex.length % 2 || !/^[0-9a-f]+$/i.test(hex)) {
    throw new Error('MiniMax 未返回完整音频');
  }
  const bytes = Buffer.from(hex, 'hex');
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(audio, bytes);
  const manifest = { createdAt: new Date().toISOString(), provider: 'MiniMax', model: body.model,
    voice: body.voice_setting.voice_id, text, file: 'chinese-test.mp3',
    durationMs: data.extra_info?.audio_length, bytes: bytes.length,
    traceId: typeof data.trace_id === 'string' ? data.trace_id : undefined };
  await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  console.log(JSON.stringify({ audio, durationMs: manifest.durationMs, bytes: bytes.length }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
