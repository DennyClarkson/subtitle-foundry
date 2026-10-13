const defaults = {
 asr: { model:'large-v3-turbo-q5_0', language:'auto', threads:8, maxChars:72, maxDuration:6, audioTrack:0, prompt:'', start:0, duration:0 },
 translate: { model:'deepseek-flash', sourceLanguage:'auto', targetLanguage:'简体中文', mode:'bilingual', glossary:'', chunkSize:35, polish:true },
 style: { preset:'cinema', font:'Microsoft YaHei', fontSize:48, secondarySize:36, primaryColor:'#FFFFFF', secondaryColor:'#F4D799', outlineColor:'#101519', backColor:'#000000', outline:2.4, shadow:1, bold:false, alignment:2, marginV:52, marginL:70, marginR:70, spacing:0, borderStyle:1, secondaryOnTop:false, subtitleMode:'bilingual', encoding:'utf8bom', maxLineChars:42, offset:0, playResX:1920, playResY:1080, stripFinalPeriod:false, trimToSpeechEnd:false, endPaddingMs:80, endTrimMs:0, fillGapsMs:0, maxCueDuration:0 },
 encode: { preset:'balanced', container:'mp4', codec:'libx264', qualityMode:'quality', quality:20, bitrate:6000, maxrate:0, bufsize:0, speed:'medium', pixelFormat:'yuv420p', profile:'auto', resolution:'source', fps:'source', audioCodec:'aac', audioBitrate:192, audioSampleRate:'source', audioChannels:'source', audioTrack:0, faststart:true, tune:'auto', deinterlace:false, colorMode:'source', threads:0 }
};
module.exports = { defaults };
