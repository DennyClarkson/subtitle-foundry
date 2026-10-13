const fs=require('node:fs/promises');const path=require('node:path');const service=require('../electron/service.cjs');const {defaults}=require('../shared/defaults.cjs');const {buildEncodeArgs}=require('../electron/core/encoding.cjs');const {run}=require('../electron/core/process.cjs');const {paths}=require('../electron/paths.cjs');
async function exists(file){try{return JSON.parse(await fs.readFile(file,'utf8'))}catch{return null}}
async function sample(name,input,language,target){
 const dir=path.join(paths.outputs,`validation-${name}`);await fs.mkdir(dir,{recursive:true});const media=await service.probe(input);
 const context={onProgress:p=>console.log(`${name}: ${p.message}`)};
 let transcript=await exists(path.join(dir,'result.json'));if(!transcript){transcript=await service.transcribe(media,{...defaults.asr,language},dir,context);await fs.writeFile(path.join(dir,'result.json'),JSON.stringify(transcript,null,2))}
 let translated=await exists(path.join(dir,'translation.json'));if(!translated){translated=await service.translate(transcript.cues,{...defaults.translate,sourceLanguage:language,targetLanguage:target},context);await fs.writeFile(path.join(dir,'translation.json'),JSON.stringify(translated,null,2))}
 if(translated.cues.length!==transcript.cues.length||translated.cues.some((c,i)=>c.start!==transcript.cues[i].start||c.end!==transcript.cues[i].end||!c.translation))throw Error('Timestamp or translation integrity failure');
 const exp=await service.exportSubtitles({cues:translated.cues,style:defaults.style,mode:'bilingual',name,media},dir);
 for(const mode of ['source','translation']){const dest=path.join(dir,mode);await fs.mkdir(dest,{recursive:true});await service.exportSubtitles({cues:translated.cues,style:{...defaults.style,subtitleMode:mode,encoding:mode==='source'?'utf16le':'utf8'},mode,name,media},dest)}
 const output=path.join(dir,'subtitled.mp4');try{await fs.access(output)}catch{
  const args=buildEncodeArgs({input,output,assPath:'subtitles.ass',options:{...defaults.encode,codec:'h264_nvenc',speed:'p4',quality:22},duration:media.duration});
  await run(paths.ffmpeg,args,{cwd:dir,onOutput:t=>{const m=/out_time_us=(\d+)/.exec(t);if(m)console.log(`${name}: encode ${Math.round(Number(m[1])/1e6)}s`)}})
 }
 const encoded=await service.probe(output);if(Math.abs(encoded.duration-media.duration)>0.3||encoded.width!==media.width||encoded.height!==media.height)throw Error('Output media mismatch');
 const frame=path.join(dir,'frame.png');await run(paths.ffmpeg,['-hide_banner','-loglevel','error','-y','-ss','6','-i',output,'-frames:v','1',frame]);
 await fs.writeFile(path.join(dir,'project.json'),JSON.stringify({version:1,portableRoot:paths.root,media,cues:translated.cues,settings:{...defaults,translate:{...defaults.translate,sourceLanguage:language,targetLanguage:target}},lastExport:exp},null,2));
 return {name,media:input,duration:media.duration,cues:transcript.cues.length,translated:translated.cues.length,output,frame,subtitleFiles:exp.files,codec:encoded.codec,audioCodec:encoded.audioCodec};
}
(async()=>{
 const which=process.argv[2]||'all',results=[];
 if(which==='all'||which==='english')results.push(await sample('english',path.join(paths.root,'final_video.mp4'),'en','简体中文'));
 if(which==='all'||which==='chinese')results.push(await sample('chinese',path.join(paths.outputs,'test-chinese-youtube/chinese-sample.mp4'),'zh','English'));
 await fs.writeFile(path.join(paths.outputs,`validation-${which}.json`),JSON.stringify({at:new Date().toISOString(),results},null,2));console.log(JSON.stringify(results,null,2));
})().catch(e=>{console.error(e.message);process.exitCode=1});
