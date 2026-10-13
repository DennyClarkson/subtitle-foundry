'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {paths,setWorkspaceRoot,inside}=require('../electron/paths.cjs');
const {initializeWorkspace}=require('../electron/workspace.cjs');
const {runBatch}=require('../electron/batch.cjs');
const {run}=require('../electron/core/process.cjs');
const {builtinPreset}=require('../shared/workflow.cjs');
const {parseSrt}=require('../electron/core/subtitles.cjs');
const {applyCueTiming}=require('../shared/timing.mjs');
const service=require('../electron/service.cjs');
// Disposable sibling workspace proves media and outputs can live outside the app.
// No runtimes/dependencies are installed there. All test data is removed in finally.
async function main(){
 const previous=paths.workspace;
 const testRoot=path.join(path.dirname(paths.root),'ASR-workspace-verification-'+randomUUID());
 const report={startedAt:new Date().toISOString(),externalWorkspace:!inside(testRoot,paths.root),checks:[],videos:[]};
 try{
  await initializeWorkspace(testRoot);
  for(const [name,start]of [['English one.mp4',0],['English two.mp4',14]]){
   await run(paths.ffmpeg,['-v','error','-nostdin','-ss',String(start),'-i',path.join(paths.root,'final_video.mp4'),'-t','7','-vf','scale=960:540','-r','30','-c:v','libx264','-preset','fast','-crf','24','-c:a','aac',path.join(testRoot,'inputs',name)],{timeout:60000});
  }
  let previousMessage='';
  const result=await runBatch({workspaceRoot:testRoot,preset:structuredClone(builtinPreset)},{onProgress:patch=>{const item=patch.batch?.items.find(i=>i.status==='running');const message=item?`${item.name}: ${item.stage}`:patch.message;if(message!==previousMessage){console.log(message);previousMessage=message;}}});
  assert.equal(result.completed,2);assert.equal(result.failed,0);assert.equal(result.cancelled,0);
  for(const item of result.items){
   assert(inside(item.folder,path.join(testRoot,'outputs')));
   for(const name of ['subtitled.mp4','source.srt','translation.srt','subtitles.ass','project.json','workflow.json'])assert((await fs.stat(path.join(item.folder,name))).size>0);
   for(const name of ['.work','audio.wav','.encode-scratch','subtitled.partial.mp4'])await assert.rejects(fs.access(path.join(item.folder,name)),{code:'ENOENT'});
   const project=JSON.parse(await fs.readFile(path.join(item.folder,'project.json'),'utf8'));
   assert(project.cues.some(cue=>Number.isFinite(cue.speechEnd)),'real ASR should preserve lexical end metadata');
   const adjusted=applyCueTiming(project.cues,project.settings.style);
   const source=parseSrt(await fs.readFile(path.join(item.folder,'source.srt'))),target=parseSrt(await fs.readFile(path.join(item.folder,'translation.srt')));
   assert(source.length>0);assert.equal(source.length,target.length);
   for(let i=0;i<source.length;i++){assert.equal(source[i].start,target[i].start);assert.equal(source[i].end,target[i].end);assert(Math.abs(source[i].end-adjusted[i].end)<=0.001);assert(!/(?<![.。])[.。]$/.test(source[i].text));assert(!/(?<![.。])[.。]$/.test(target[i].text));}
   const ass=await fs.readFile(path.join(item.folder,'subtitles.ass'),'utf8');assert(ass.includes('&H00B46428'));assert(ass.includes('{\\rSecondary}'));
   const probe=await service.probe(path.join(item.folder,'subtitled.mp4'));assert(probe.duration>=6.9&&probe.duration<=7.2);assert.equal(probe.codec,'h264');
   await run(paths.ffmpeg,['-v','error','-i',path.join(item.folder,'subtitled.mp4'),'-f','null','-'],{timeout:60000});
   report.videos.push({name:item.name,cueCount:source.length,duration:probe.duration,codec:probe.codec,firstSource:source[0].text,firstTranslation:target[0].text});
  }
  report.checks=['external selected workspace','2 real Whisper transcriptions','2 real DeepSeek translations','2 complete per-video artifact sets','SRT times and final punctuation','speech-end metadata and timing applied once','scratch audio/work/partial files removed','ASS blue translated style','FFmpeg full decode'];
  if(process.argv.includes('--keep-review')){
   const first=result.items[0],cues=parseSrt(await fs.readFile(path.join(first.folder,'source.srt')));
   const frame=path.join(paths.temp,'workspace-style-verification.png');
   await run(paths.ffmpeg,['-v','error','-y','-ss',String((cues[0].start+cues[0].end)/2),'-i',path.join(first.folder,'subtitled.mp4'),'-frames:v','1',frame],{timeout:30000});
   report.frame=frame;await fs.writeFile(path.join(paths.temp,'workspace-validation-report.json'),JSON.stringify(report,null,2));
  }
  console.log(JSON.stringify(report,null,2));
 }finally{
  setWorkspaceRoot(previous);
  const resolved=path.resolve(testRoot),parent=path.resolve(path.dirname(paths.root));
  assert.equal(path.dirname(resolved),parent);assert(path.basename(resolved).startsWith('ASR-workspace-verification-'));
  await fs.rm(resolved,{recursive:true,force:true,maxRetries:3,retryDelay:100});
 }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
