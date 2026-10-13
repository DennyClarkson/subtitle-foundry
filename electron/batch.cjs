const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {paths,assertInside,folder}=require('./paths.cjs');
const {scanInputs}=require('./workspace.cjs');
const {normalizePreset,normalizeWorkflowCues}=require('../shared/workflow.cjs');
const {pruneCache,removeScratch,markScratch}=require('./storage.cjs');

function abortError(){const error=new Error('批量任务已取消');error.name='AbortError';return error;}
async function runBatch({workspaceRoot,preset},context={},deps=require('./service.cjs')) {
 // Clone before the first await: editor changes cannot mutate an active run.
 preset=normalizePreset(structuredClone(preset));
 workspaceRoot=assertInside(workspaceRoot,paths.workspace);
 if(path.resolve(workspaceRoot)!==path.resolve(paths.workspace))throw new Error('批量任务工作区已改变，请刷新后重试');
 const outputs=assertInside(path.join(workspaceRoot,'outputs'),workspaceRoot);
 const batchId=randomUUID();
 const manifestDir=assertInside(path.join(workspaceRoot,'.subtitle-foundry','batches'),workspaceRoot);
 await fs.mkdir(manifestDir,{recursive:true});
 const manifest=path.join(manifestDir,batchId+'.json');
 const videos=await scanInputs(workspaceRoot,preset.batch.recursive);
 const items=videos.map(video=>({input:video.path,name:video.relativePath,status:'pending',stage:'waiting',progress:0}));
 const result={folder:outputs,items,presetName:preset.name,completed:0,failed:0,cancelled:0};
 const startedAt=new Date().toISOString();let current=0,primaryFailure=false;
 const summarize=()=>{for(const status of ['completed','failed','cancelled'])result[status]=items.filter(item=>item.status===status).length;return result;};
 const emit=(message)=>{
  summarize();
  context.onProgress?.({stage:'batch',progress:items.length?items.reduce((sum,item)=>sum+(['completed','failed','cancelled'].includes(item.status)?100:item.progress),0)/items.length:100,message,batch:{presetName:preset.name,items:structuredClone(items),current,total:items.length}});
 };
 const persist=async()=>{await deps.saveJSON(manifest,{version:1,batchId,workspaceRoot,preset,startedAt,updatedAt:new Date().toISOString(),...summarize()});await pruneCache('batches',{keep:[manifest]});};
 const check=()=>{if(context.signal?.aborted)throw abortError();};
 const persistItem=async(item,details={})=>{
  if(item.folder)await deps.saveJSON(path.join(item.folder,'workflow.json'),{version:1,batchId,preset,startedAt,updatedAt:new Date().toISOString(),...item,...details});
 };
 emit(items.length?`发现 ${items.length} 个视频，开始批量处理…`:'输入文件夹中没有视频');await persist();
 for(let index=0;index<items.length;index++) {
  const item=items[index];current=index+1;let work,primaryError,aborted;let itemDetails={};
  try {
   check();item.folder=folder(path.parse(item.name).name,outputs);
   work=assertInside(path.join(item.folder,'.work'),item.folder);await fs.mkdir(work);
   await markScratch(work,'.subtitle-foundry-scratch');
   item.status='running';
   const stage=(name,progress,message)=>{check();item.stage=name;item.progress=progress;emit(message);};
   const childContext=(name,base,span)=>({signal:context.signal,onProgress:patch=>{if(context.signal?.aborted)return;item.stage=patch.stage||name;item.progress=Math.min(99,base+Math.max(0,Math.min(100,Number(patch.progress)||0))*span/100);emit(`${item.name} · ${patch.message||name}`);}});
   stage('probe',1,`${item.name} · 读取视频信息…`);
   const media=await deps.probe(item.input);check();
   stage('transcribe',5,`${item.name} · 本地转写…`);
   const transcript=await deps.transcribe(media,preset.settings.asr,work,childContext('transcribe',5,35));check();
   stage('translate',40,`${item.name} · 翻译字幕…`);
   const translationDir=path.join(work,'translation');await fs.mkdir(translationDir);
   const translated=await deps.translate(transcript.cues,preset.settings.translate,childContext('translate',40,25),translationDir);check();
   const cues=normalizeWorkflowCues(translated.cues,preset.settings.style);
   stage('export',65,`${item.name} · 导出字幕…`);
   const lastExport=await deps.exportSubtitles({cues,style:preset.settings.style,mode:preset.settings.translate.mode,name:item.name,media},item.folder);check();
   stage('encode',70,`${item.name} · 烧录视频…`);
   const burned=await deps.burn({media,cues,style:preset.settings.style,encode:preset.settings.encode,preview:false},childContext('encode',70,29),item.folder);check();
   const project={version:1,portableRoot:paths.root,workspaceRoot,media,cues,settings:preset.settings,lastExport,batchId,output:burned};
   await fs.copyFile(path.join(work,'transcript.txt'),path.join(item.folder,'transcript.txt')).catch(error=>{if(error.code!=='ENOENT')throw error;});
   await deps.saveJSON(path.join(item.folder,'project.json'),project);
   await deps.saveJSON(assertInside(path.join(workspaceRoot,'projects',path.basename(item.folder)+'.json'),workspaceRoot),project);
   check();item.status='completed';item.stage='completed';item.progress=100;
   itemDetails={output:burned.path,files:lastExport.files};await persistItem(item,itemDetails);
   await persist();emit(`${item.name} · 完成`);
  } catch(error) {
   primaryError=error;primaryFailure=true;
   const cancelled=context.signal?.aborted||error.name==='AbortError';
   item.status=cancelled?'cancelled':'failed';item.stage=item.status;item.error=String(error.message||error);
   if(cancelled||!preset.batch.continueOnError) {
    for(const pending of items.slice(index+1)){pending.status='cancelled';pending.stage='cancelled';pending.error=cancelled?'批量任务已取消':'前一视频失败，已停止后续处理';}
   }
   try{await persistItem(item);await persist();}catch(persistError){item.persistenceWarning=`无法保存任务状态：${persistError.message||persistError}`;}
   try{emit(`${item.name} · ${cancelled?'已取消':'失败：'+item.error}${item.persistenceWarning?'；'+item.persistenceWarning:''}`);}catch{}
   if(cancelled){aborted=abortError();aborted.result=structuredClone(summarize());throw aborted;}
   if(!preset.batch.continueOnError)break;
  } finally {
   if(work)try{await removeScratch(work,item.folder);}catch(cleanupError){
    item.cleanupWarning=`临时文件清理失败，将在后续启动时重试：${cleanupError.message||cleanupError}`;
    // Recursive removal may have deleted the marker before hitting a locked
    // descendant. Restore it while the surviving scratch directory is writable.
    try{await markScratch(work,'.subtitle-foundry-scratch');}catch(markerError){item.cleanupWarning+=`；无法恢复清理标记：${markerError.message||markerError}`;}
    try{await persistItem(item,itemDetails);await persist();}catch(persistError){
     item.cleanupWarning+=`；无法保存清理警告：${persistError.message||persistError}`;
     if(!primaryError)throw persistError;
    }
    // Keep the original item result and cancellation intact; cleanup alone must
    // not turn a successful output into a failed video or stop continue-on-error.
    try{emit(`${item.name} · ${item.cleanupWarning}`);}catch(error){if(!primaryError)throw error;}
    if(aborted)aborted.result=structuredClone(summarize());
   }
  }
 }
 const warnings=items.filter(item=>item.cleanupWarning).length;
 emit(`批量处理结束：成功 ${summarize().completed}，失败 ${result.failed}，取消 ${result.cancelled}${warnings?`，${warnings} 项临时文件清理警告`:''}`);
 try{await persist();await pruneCache('batches');}catch(error){if(!primaryFailure)throw error;result.persistenceWarning=`无法保存最终任务状态：${error.message||error}`;}
 return structuredClone(result);
}
module.exports={runBatch};
