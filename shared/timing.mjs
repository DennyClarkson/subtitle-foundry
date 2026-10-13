// Shared by the browser preview and Node exporters. Always pass raw project cues:
// these are derived display times, never timestamps to persist over the source.
const timingDefaults = { trimToSpeechEnd: false, endPaddingMs: 80, endTrimMs: 0, fillGapsMs: 0, maxCueDuration: 0 };

export function normalizeTimingOptions(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('字幕时间设置必须是对象');
  const options = { ...timingDefaults };
  for (const key of Object.keys(options)) if (input[key] !== undefined) options[key] = input[key];
  if (typeof options.trimToSpeechEnd !== 'boolean') throw new Error('字幕样式 trimToSpeechEnd 必须是布尔值');
  for (const [key, max] of [['endPaddingMs', 2000], ['endTrimMs', 5000], ['fillGapsMs', 5000], ['maxCueDuration', 30]]) {
    const value = options[key];
    if (value === null || typeof value === 'boolean' || String(value).trim() === '' || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > max) throw new Error(`字幕样式 ${key} 超出有效范围`);
    options[key] = Number(value);
    if (key !== 'maxCueDuration' && !Number.isInteger(options[key])) throw new Error(`字幕样式 ${key} 必须是整数毫秒`);
  }
  if (options.maxCueDuration > 0 && options.maxCueDuration < 0.01) throw new Error('字幕最长显示时长至少为 0.01 秒，0 表示关闭');
  return options;
}

export function applyCueTiming(cues, style = {}) {
  const options = normalizeTimingOptions(style);
  if (!Array.isArray(cues)) throw new Error('字幕条目必须是数组');
  const result = cues.map((cue, index) => {
    if (!cue || !Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.start < 0 || cue.end <= cue.start) throw new Error(`第 ${index + 1} 条字幕时间无效`);
    let end = cue.end;
    if (options.trimToSpeechEnd && Number.isFinite(cue.speechEnd) && cue.speechEnd > cue.start && cue.speechEnd <= cue.end) end = Math.min(end, cue.speechEnd + options.endPaddingMs / 1000);
    end -= options.endTrimMs / 1000;
    if (options.maxCueDuration > 0) end = Math.min(end, cue.start + options.maxCueDuration);
    // Never lengthen an already very short source cue, or introduce an overlap.
    end = Math.max(Math.min(cue.end, cue.start + 0.01), end);
    return { ...cue, end };
  }).sort((a, b) => a.start - b.start || a.end - b.end);
  if (options.fillGapsMs > 0) {
    for (let i = 0; i < result.length - 1; i++) {
      const cue = result[i], next = result[i + 1];
      const gap = next.start - cue.end;
      // Filling is last: short gaps may override trimming, but never the explicit
      // duration cap. If reaching the next cue exceeds that cap, leave the gap.
      if (gap > 0 && gap <= options.fillGapsMs / 1000 + 1e-9 && (options.maxCueDuration === 0 || next.start - cue.start <= options.maxCueDuration + 1e-9)) cue.end = next.start;
    }
  }
  return result;
}
