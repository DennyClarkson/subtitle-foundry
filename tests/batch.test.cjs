const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');
const {paths,setWorkspaceRoot}=require('../electron/paths.cjs');const {initializeWorkspace}=require('../electron/workspace.cjs');const {runBatch}=require('../electron/batch.cjs');const {builtinPreset}=require('../shared/workflow.cjs');const {exportSubtitles}=require('../electron/service.cjs');
async function fixture(run){const root=await fs.mkdtemp(path.join(paths.temp,'batch-test-'));const previous=paths.workspace;try{await initializeWorkspace(root);for(const name of ['one.mp4','two.mp4'])await fs.writeFile(path.join(root,'inputs',name),'test');await run(root);}finally{if(previous)await setWorkspaceRoot(previous);assert(path.relative(paths.temp,root).startsWith('batch-test-'));await fs.rm(root,{recursive:true,force:true});}}
function dependencies(overrides={}){return {
 probe:async input=>({path:input,duration:2,width:1920,height:1080}),
 transcribe:async(_media,_options,dest)=>{assert.equal(path.basename(dest),'.work');return {cues:[{id:1,start:0,end:1,text:'Hello.'}]};},
 translate:async(cues,_options,_context,dest)=>{assert.equal(path.basename(path.dirname(dest)),'.work');return {cues:cues.map(c=>({...c,translation:'你好。'}))};},
 exportSubtitles,
 burn:async(input,context,dest)=>{context.onProgress?.({stage:'encode',progress:50});const file=path.join(dest,'subtitled.mp4');await fs.writeFile(file,'mock video');return {path:file,folder:dest};},
 saveJSON:async(file,value)=>fs.writeFile(file,JSON.stringify(value,null,2)),...overrides};}
test('batch creates isolated artifacts, cleans cue punctuation and snapshots settings',async()=>fixture(async root=>{
 const preset=structuredClone(builtinPreset);const progress=[];let observed;
 const pending=runBatch({workspaceRoot:root,preset},{onProgress:p=>progress.push(p)},dependencies({transcribe:async(_media,options)=>{observed=options.language;return {cues:[{id:1,start:0,end:1,text:'Hello.'}]};}}));preset.settings.asr.language='fr';preset.name='mutated';
 const result=await pending;assert.equal(result.completed,2);assert.equal(result.failed,0);assert.equal(observed,'en');assert.equal(result.presetName,builtinPreset.name);assert.notEqual(result.items[0].folder,result.items[1].folder);
 for(const item of result.items){assert.equal(path.dirname(item.folder),path.join(root,'outputs'));for(const file of ['source.srt','translation.srt','subtitles.ass','subtitled.mp4','project.json','workflow.json'])await fs.access(path.join(item.folder,file));assert(!((await fs.readFile(path.join(item.folder,'source.srt'),'utf8')).includes('Hello.')));const workflow=JSON.parse(await fs.readFile(path.join(item.folder,'workflow.json'),'utf8'));assert.equal(workflow.status,'completed');assert.equal(workflow.preset.name,builtinPreset.name);}
 assert.equal(progress.at(-1).progress,100);assert.equal((await fs.readdir(path.join(root,'projects'))).length,2);
}));
test('batch preserves partial failures and honors stop-on-error',async()=>fixture(async root=>{
 const preset=structuredClone(builtinPreset);const failed=dependencies({probe:async input=>{if(input.endsWith('one.mp4'))throw new Error('broken input');return {path:input,duration:2};}});
 const result=await runBatch({workspaceRoot:root,preset},{},failed);assert.equal(result.failed,1);assert.equal(result.completed,1);assert.match(result.items[0].error,/broken input/);
 preset.batch.continueOnError=false;const stopped=await runBatch({workspaceRoot:root,preset},{},failed);assert.equal(stopped.failed,1);assert.equal(stopped.cancelled,1);assert.equal(stopped.completed,0);
}));
test('batch cancellation saves manifest and cancels remaining inputs',async()=>fixture(async root=>{
 const controller=new AbortController();const progress=[];let caught;
 try{await runBatch({workspaceRoot:root,preset:builtinPreset},{signal:controller.signal,onProgress:p=>progress.push(p)},dependencies({transcribe:async()=>{controller.abort();return {cues:[]};}}));}catch(error){caught=error;}
 assert.equal(caught.name,'AbortError');assert.equal(caught.result.cancelled,2);assert.equal(caught.result.completed,0);assert(progress.at(-1).batch.items.every(item=>item.status==='cancelled'));
 const manifests=await fs.readdir(path.join(root,'.subtitle-foundry','batches'));const manifest=JSON.parse(await fs.readFile(path.join(root,'.subtitle-foundry','batches',manifests[0]),'utf8'));assert.equal(manifest.cancelled,2);assert.equal(manifest.items[0].status,'cancelled');
}));
test('source-only preset preserves its export and style options',async()=>fixture(async root=>{
 const preset=structuredClone(builtinPreset);preset.settings.translate.mode='source';preset.settings.style.subtitleMode='source';preset.settings.style.stripFinalPeriod=false;
 const result=await runBatch({workspaceRoot:root,preset},{},dependencies({translate:async cues=>({cues})}));
 assert.equal(result.completed,2);for(const item of result.items){assert.match(await fs.readFile(path.join(item.folder,'source.srt'),'utf8'),/Hello\./);await assert.rejects(fs.access(path.join(item.folder,'translation.srt')),{code:'ENOENT'});}
}));
