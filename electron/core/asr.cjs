const fs=require('node:fs/promises');const path=require('node:path');
const {paths}=require('../paths.cjs');const {run}=require('./process.cjs');const {modelPath}=require('./models.cjs');
const ordinaryToken = t => t && typeof t.text === 'string' && t.text && !/^\[[_A-Z].*\]$/.test(t.text) && !/^<\|.*\|>$/.test(t.text);
function speechMetadata(tokens,text,start,end,offset){
 // Require full text coverage and inspect the actual final lexical token. A
 // zero-duration final word must not cause us to trim to an earlier word.
 const ordinary=tokens.filter(ordinaryToken);
 if(ordinary.map(t=>t.text).join('').replace(/\s/g,'')!==text.replace(/\s/g,''))return {};
 const last=ordinary.findLast(t=>/[\p{L}\p{N}]/u.test(t.text));
 if(!last||!Number.isFinite(last.offsets?.from)||!Number.isFinite(last.offsets?.to)||last.offsets.to<=last.offsets.from)return {};
 const speechEnd=last.offsets.to/1000+offset;
 if(last.offsets.from/1000+offset<start||speechEnd<=start||speechEnd>end)return {};
 return {speechEnd};
}
function whisperCues(json,{offset=0,maxDuration=6}={}){
 const result=[];let previousEnd=0;
 for(const segment of json.transcription||[]){
  const start=Number(segment.offsets?.from)/1000,end=Number(segment.offsets?.to)/1000;
  const text=String(segment.text||'').trim();if(!text||!Number.isFinite(start)||!Number.isFinite(end)||end<=start)continue;
  const segmentTokens=Array.isArray(segment.tokens)?segment.tokens:[];
  const tokens=segmentTokens.filter(t=>ordinaryToken(t)&&Number.isFinite(t.offsets?.from)&&Number.isFinite(t.offsets?.to)&&t.offsets.to>t.offsets.from);
  const groups=[];
  if(end-start>maxDuration&&tokens.length>1){
   let group=[];for(const t of tokens){if(group.length && (t.offsets.to-group[0].offsets.from)/1000>maxDuration && (/^\s/.test(t.text)||/[\u3400-\u9fff]/.test(t.text))){groups.push(group);group=[]}group.push(t)}if(group.length)groups.push(group);
  }
  if(groups.length>1 && groups.map(g=>g.map(t=>t.text).join('')).join('').replace(/\s/g,'')===text.replace(/\s/g,'')){
   for(const group of groups){const from=Math.max(previousEnd,group[0].offsets.from/1000+offset),to=Math.max(from+.01,group.at(-1).offsets.to/1000+offset),body=group.map(t=>t.text).join('').trim();result.push({id:result.length+1,start:from,end:to,text:body,...speechMetadata(group,body,from,to,offset)});previousEnd=to}
  }else{const from=Math.max(previousEnd,start+offset),to=Math.max(from+.01,end+offset);result.push({id:result.length+1,start:from,end:to,text,...speechMetadata(segmentTokens,text,from,to,offset)});previousEnd=to}
 }
 if(!result.length)throw new Error('没有识别到语音。请检查音轨、语言和截取范围，或更换模型。');
 return result;
}
async function transcribe(media,options,folder,{signal,onProgress}={}){
 const opt={threads:8,start:0,duration:0,maxChars:72,maxDuration:6,audioTrack:0,language:'auto',...options};
 if(!/^(auto|[a-z]{2,3})$/.test(opt.language))throw new Error('转写语言代码无效');
 for(const field of ['threads','start','duration','maxChars','maxDuration','audioTrack'])if(!Number.isFinite(Number(opt[field])))throw new Error(`转写参数 ${field} 无效`);
 if(opt.start<0||opt.start>=media.duration||opt.duration<0||opt.threads<1||opt.threads>64||opt.maxChars<10||opt.maxChars>300||opt.maxDuration<1||opt.maxDuration>30||opt.audioTrack<0||!Number.isInteger(opt.audioTrack))throw new Error('转写参数超出允许范围');
 const model=modelPath(opt.model);await fs.access(model).catch(()=>{throw new Error('请先在模型管理中下载所选转写模型')});
 const audio=path.join(folder,'audio.wav'),prefix=path.join(folder,'transcript');
 let failed=false;
 try{
 const args=['-hide_banner','-nostdin','-y'];if(opt.start>0)args.push('-ss',String(opt.start));args.push('-i',media.path);if(opt.duration>0)args.push('-t',String(opt.duration));args.push('-map',`0:a:${opt.audioTrack}`,'-vn','-ac','1','-ar','16000','-c:a','pcm_s16le',audio);
 onProgress?.({stage:'extract',progress:3,message:'提取 16 kHz 单声道音频…'});await run(paths.ffmpeg,args,{cwd:folder,signal});
 const cli=['-m',model,'-f',audio,'-l',opt.language,'-t',String(opt.threads),'-ojf','-otxt','-of',prefix,'-ml',String(opt.maxChars),'-sow','-pp','-ng'];
 if(opt.prompt)cli.push('--prompt',String(opt.prompt).slice(0,3000));
 onProgress?.({stage:'transcribe',progress:10,message:`正在使用 ${opt.model} 转写，本地处理音频…`});
 await run(paths.whisper,cli,{cwd:folder,signal,onOutput(text){const matches=[...text.matchAll(/progress\s*=\s*(\d+)%/g)];if(matches.length)onProgress?.({stage:'transcribe',progress:10+Number(matches.at(-1)[1])*.86,message:`本地转写 ${matches.at(-1)[1]}%`})}});
 const json=JSON.parse(await fs.readFile(prefix+'.json','utf8'));const cues=whisperCues(json,{offset:opt.start,maxDuration:opt.maxDuration});
 await fs.writeFile(path.join(folder,'cues.json'),JSON.stringify(cues,null,2));
 return {cues,transcriptPath:prefix+'.txt',rawPath:prefix+'.json',folder,language:json.result?.language};
 }catch(error){failed=true;throw error;}finally{
  // Process promises settle after child exit, so cancellation/failure can safely
  // release the rebuildable extraction without removing transcript deliverables.
  // Preserve the useful transcription failure if cleanup also fails. A cleanup
  // failure after success remains an error, leaving the service recovery marker.
  try{await fs.rm(audio,{force:true});}catch(error){if(!failed)throw error;}
 }
}
module.exports={transcribe,whisperCues};
