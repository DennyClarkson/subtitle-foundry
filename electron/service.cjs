const fs=require('node:fs');const fsp=fs.promises;const path=require('node:path');
const {paths,folder,assertInside}=require('./paths.cjs');const {run}=require('./core/process.cjs');
const {listModels,downloadModel}=require('./core/models.cjs');const {transcribe:transcribeCore}=require('./core/asr.cjs');
const {normalizeCues,normalizeWorkflowCues,serializeSrt,buildAss,encodeSubtitle}=require('./core/subtitles.cjs');
const {buildEncodeArgs,validateEncode,parseProbe,encoderCatalog}=require('./core/encoding.cjs');const {translateCues}=require('./core/deepseek.cjs');
const {defaults}=require('../shared/defaults.cjs');
const {applyCueTiming}=require('../shared/timing.mjs');
const {pruneCache,removeScratch,markScratch}=require('./storage.cjs');
async function temporaryGone(file){try{await fsp.lstat(file);return false;}catch(error){if(error.code==='ENOENT')return true;throw error;}}
async function transcribe(media,options,dest,context){
 const marker=await markScratch(dest,'.asr-scratch');let failed=false;
 try{return await transcribeCore(media,options,dest,context);}catch(error){failed=true;throw error;}
 finally{try{if(await temporaryGone(path.join(dest,'audio.wav')))await fsp.rm(marker,{force:true});}catch(error){if(!failed)throw error;}}
}
function keyPresent(name){return Object.entries(process.env).some(([k,v])=>k.toLowerCase()===name.toLowerCase()&&Boolean(v))}
let availableEncoders;
async function status(){
 if(!availableEncoders&&fs.existsSync(paths.ffmpeg)){const {stdout}=await run(paths.ffmpeg,['-hide_banner','-encoders'],{timeout:15000});availableEncoders=[...stdout.matchAll(/^\s+V[A-Z.]{5}\s+(\S+)/gm)].map(m=>m[1]).filter(id=>encoderCatalog.some(e=>e.id===id))}
 return {root:paths.root,ffmpeg:fs.existsSync(paths.ffmpeg)&&fs.existsSync(paths.ffprobe),whisper:fs.existsSync(paths.whisper),deepseek:keyPresent('Deepseek'),minimax:keyPresent('MINIMAX'),models:listModels(),encoders:availableEncoders||[],version:'1.0.0'};
}
async function probe(file){file=path.resolve(file);if(!(await fsp.stat(file)).isFile())throw new Error('请选择本地视频文件');const {stdout}=await run(paths.ffprobe,['-v','error','-show_format','-show_streams','-of','json',file],{timeout:20000});return parseProbe(JSON.parse(stdout),file)}
async function exportSubtitles({cues,style,mode,name,media},outputFolder){
 style={...defaults.style,...style};cues=normalizeWorkflowCues(cues,style);if(!['source','translation','bilingual'].includes(mode))throw new Error('无效的字幕输出模式');
 if((mode!=='source'||style.subtitleMode!=='source')&&cues.some(c=>!c.translation?.trim()))throw new Error('部分字幕没有译文，请先完成翻译，或将 SRT 和 ASS 模式都设为原文。');
 const dest=outputFolder?assertInside(outputFolder):folder(name||'subtitles',path.join(paths.workspace,'subtitles'));await fsp.mkdir(dest,{recursive:true});const files=[];
 async function write(label,filename,text,encoding){const file=path.join(dest,filename);await fsp.writeFile(file,encodeSubtitle(text,encoding));files.push({label,path:file})}
 // Offsets apply once to exported SRT and ASS, leaving editor and transcript times intact.
 const adjusted=normalizeCues(applyCueTiming(cues,style).map(c=>({...c,start:Math.max(0,c.start+Number(style.offset||0)),end:c.end+Number(style.offset||0)})).filter(c=>c.end>c.start));
 if(mode==='source'||mode==='bilingual')await write('原文 SRT','source.srt',serializeSrt(adjusted,'text'),style.encoding);
 if(mode==='translation'||mode==='bilingual')await write('译文 SRT','translation.srt',serializeSrt(adjusted,'translation'),style.encoding);
 await write('样式 ASS','subtitles.ass',buildAss(cues,style),'utf8bom');
 await fsp.writeFile(path.join(dest,'export-manifest.json'),JSON.stringify({version:1,media,cues,style,mode},null,2));
 return {folder:dest,files,cues};
}
async function burn({media,cues,style,encode,preview=false},context={},outputFolder){
 const options=validateEncode(encode);cues=normalizeCues(cues);style={...defaults.style,...style};
 const dest=outputFolder?assertInside(outputFolder):folder(preview?'preview':'encoded',preview?path.join(paths.workspaceData,'previews'):paths.outputs);await fsp.mkdir(dest,{recursive:true});const assPath=path.join(dest,'subtitles.ass');
 if(preview)await fsp.writeFile(path.join(dest,'.preview-cache'),'1');
 const marker=await markScratch(dest,'.encode-scratch');
 const output=path.join(dest,preview?'preview.mp4':`subtitled.${options.container}`);
 const partial=path.join(dest,preview?'preview.partial.mp4':`subtitled.partial.${options.container}`);
 let succeeded=false,failed=false;
 try{
 await fsp.writeFile(assPath,encodeSubtitle(buildAss(cues,style),'utf8bom'));
 const previewOptions={...defaults.encode,codec:'libx264',container:'mp4',resolution:'1280x720',speed:'fast',quality:22,audioTrack:options.audioTrack};
 const args=buildEncodeArgs({input:media.path,output:partial,assPath:'subtitles.ass',options:preview?previewOptions:options,duration:media.duration,preview});
 await fsp.writeFile(path.join(dest,'ffmpeg-arguments.json'),JSON.stringify({executable:'tools/ffmpeg/ffmpeg.exe',cwd:'.',args},null,2));
 context.onProgress?.({stage:'encode',progress:1,message:preview?'正在渲染真实 ASS 预览…':'正在烧录字幕并编码视频…'});
 let progressBuffer='';const total=preview?Math.min(media.duration,12):media.duration;
 await run(paths.ffmpeg,args,{cwd:dest,signal:context.signal,onOutput(text){progressBuffer=(progressBuffer+text).slice(-5000);const all=[...progressBuffer.matchAll(/out_time_(?:us|ms)=(\d+)/g)];if(all.length){const elapsed=Number(all.at(-1)[1])/1e6;context.onProgress?.({stage:'encode',progress:Math.min(99,elapsed/total*100),message:`${preview?'预览':'视频编码'} · ${Math.round(elapsed)} / ${Math.round(total)} 秒`})}}});
 context.signal?.throwIfAborted();await fsp.rename(partial,output);succeeded=true;
 if(preview)await pruneCache('previews',{keep:[dest]});
 return {path:output,folder:dest};
 }catch(error){failed=true;throw error;}finally{
  let cleanupError;
  const cleanup=async action=>{try{await action();}catch(error){cleanupError??=error;}};
  await cleanup(()=>fsp.rm(partial,{force:true}));
  // A surviving partial must retain its recovery marker for next startup.
  await cleanup(async()=>{if(await temporaryGone(partial))await fsp.rm(marker,{force:true});});
  if(preview&&!succeeded)await cleanup(async()=>{
   try{await removeScratch(dest,path.join(paths.workspaceData,'previews'));}catch(error){
    // A failed recursive removal may have removed its markers first. Recreate
    // them only in a surviving directory; never hide the primary/cleanup error.
    try{await fsp.writeFile(path.join(dest,'.preview-cache'),'1');}catch{}
    try{if(!await temporaryGone(partial))await markScratch(dest,'.encode-scratch');}catch{}
    throw error;
   }
  });
  if(cleanupError&&!failed)throw cleanupError;
 }
}
async function translate(cues,options,context={},outputFolder){
 const normalized=normalizeCues(cues);const dest=outputFolder?assertInside(outputFolder):folder('translation');await fsp.mkdir(dest,{recursive:true});await fsp.writeFile(path.join(dest,'input.json'),JSON.stringify(normalized,null,2));
 const hash=require('node:crypto').createHash('sha256').update(JSON.stringify({cues:normalized,options})).digest('hex');
 const cacheDir=assertInside(path.join(paths.workspaceData,'translation-cache'));await fsp.mkdir(cacheDir,{recursive:true});const cache=path.join(cacheDir,hash+'.json');
 await pruneCache('translation',{keep:[cache]});
 const completed=await readJSON(cache);if(completed?.cues?.length)context.onProgress?.({stage:'translate',progress:0,message:`恢复已经校验的 ${completed.cues.length} 条字幕…`});
 const result=await translateCues(normalized,options,{...context,resumeCues:completed?.cues||[],onBatchComplete:async part=>{await saveJSON(cache,{cues:part});await saveJSON(path.join(dest,'checkpoint.json'),{cues:part})}});
 await fsp.writeFile(path.join(dest,'translated.json'),JSON.stringify(result,null,2));await pruneCache('translation');return {cues:result,folder:dest};
}
async function saveJSON(file,value){assertInside(file);const tmp=assertInside(file+'.'+require('node:crypto').randomUUID()+'.tmp');let failed=false;try{await fsp.writeFile(tmp,JSON.stringify(value,null,2),{flag:'wx'});await fsp.rename(tmp,file);return file}catch(error){failed=true;throw error}finally{try{await fsp.rm(tmp,{force:true})}catch(error){if(!failed)throw error}}}
async function readJSON(file){try{return JSON.parse(await fsp.readFile(file,'utf8'))}catch(e){if(e.code==='ENOENT')return null;throw new Error(`无法读取项目文件：${e.message}`)}}
module.exports={status,probe,exportSubtitles,burn,translate,transcribe,downloadModel,saveJSON,readJSON};
