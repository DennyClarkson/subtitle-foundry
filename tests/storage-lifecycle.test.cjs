'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');
const {paths,setWorkspaceRoot}=require('../electron/paths.cjs');const {initializeWorkspace}=require('../electron/workspace.cjs');
const {pruneCache,recoverScratch,markScratch,setPreviewProtection}=require('../electron/storage.cjs');const service=require('../electron/service.cjs');
const {runBatch}=require('../electron/batch.cjs');const {builtinPreset}=require('../shared/workflow.cjs');const {defaults}=require('../shared/defaults.cjs');const {parseSrt}=require('../electron/core/subtitles.cjs');
async function fixture(action){const root=await fs.mkdtemp(path.join(paths.temp,'storage-lifecycle-'));const previous=paths.workspace,models=paths.models;try{await initializeWorkspace(root);paths.models=path.join(root,'models');await fs.mkdir(paths.models);await action(root)}finally{paths.models=models;await setWorkspaceRoot(previous);assert(path.relative(paths.temp,root).startsWith('storage-lifecycle-'));await fs.rm(root,{recursive:true,force:true})}}
async function exists(file){try{await fs.access(file);return true}catch(error){if(error.code==='ENOENT')return false;throw error}}
async function write(file,value='retained'){await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,value);return file}
async function old(file,days=10){const date=new Date(Date.now()-days*86400000);await fs.utimes(file,date,date)}

test('translation cache enforces default 100 records and simulated byte/age budgets without deleting user data',async()=>fixture(async root=>{
 const base=path.join(paths.workspaceData,'translation-cache');const sentinels=await Promise.all([write(path.join(base,'user-notes.json')),write(path.join(root,'inputs','original.mp4')),write(path.join(root,'outputs','finished','subtitled.mp4')),write(path.join(root,'projects','project.json'))]);
 for(let i=0;i<105;i++)await write(path.join(base,i.toString(16).padStart(64,'0')+'.json'),'x'.repeat(16));
 let result=await pruneCache('translation');assert.equal(result.count,100);assert.equal(result.removed,5);assert.equal(result.bytes,1600);
 result=await pruneCache('translation',{maxBytes:32});assert.equal(result.count,2);assert.equal(result.bytes,32);
 const remaining=(await fs.readdir(base)).filter(name=>/^[a-f0-9]{64}\.json$/.test(name)).map(name=>path.join(base,name));for(const file of remaining)await old(file,40);
 result=await pruneCache('translation',{keep:[remaining[0]]});assert.equal(result.count,1);assert.equal(result.removed,1);assert.equal(await exists(remaining[0]),true);
 for(const file of sentinels)assert.equal(await fs.readFile(file,'utf8'),'retained');
}));

test('preview cache keeps at most three marked folders, protects current preview and ignores unmarked folders',async()=>fixture(async root=>{
 const base=path.join(paths.workspaceData,'previews');const dirs=[];
 for(let i=0;i<6;i++){const dir=path.join(base,'preview-'+i);await write(path.join(dir,'.preview-cache'),'1');await write(path.join(dir,'preview.mp4'),'video');await old(dir,6-i);dirs.push(dir)}
 const unmarked=await write(path.join(base,'user-folder','subtitled.mp4'));const output=await write(path.join(root,'outputs','finished','preview.mp4'));
 const result=await pruneCache('previews',{keep:[dirs[0]]});assert.equal(result.count,3);assert.equal(result.removed,3);assert.equal(await exists(dirs[0]),true);assert.equal(await exists(dirs[1]),false);assert.equal(await exists(dirs[2]),false);assert.equal(await exists(dirs[3]),false);
 assert.equal(await fs.readFile(unmarked,'utf8'),'retained');assert.equal(await fs.readFile(output,'utf8'),'retained');
}));

test('scratch recovery removes only dead-owner scratch and age-gated recognizable temporaries',async()=>fixture(async root=>{
 const exited=require('node:child_process').spawnSync(process.execPath,['-e',''],{windowsHide:true});assert.equal(exited.status,0);assert.throws(()=>process.kill(exited.pid,0),{code:'ESRCH'});
 const dead=path.join(paths.outputs,'dead'),live=path.join(paths.outputs,'live'),unknown=path.join(paths.outputs,'unknown');
 for(const dir of [dead,live,unknown]){
  await write(path.join(dir,'.work','transcript.json'));await write(path.join(dir,'audio.wav'));await write(path.join(dir,'subtitled.partial.mp4'));await write(path.join(dir,'subtitled.mp4'));await write(path.join(dir,'project.json'));
  for(const name of ['.asr-scratch','.encode-scratch','.work/.subtitle-foundry-scratch'])await write(path.join(dir,name),JSON.stringify({owner:dir===unknown?'user':'subtitle-foundry',pid:dir===live?process.pid:exited.pid}));
 }
 const input=await write(path.join(root,'inputs','audio.wav'));
 const id='11111111-1111-1111-1111-111111111111',cache=path.join(paths.workspaceData,'translation-cache');
 const staleModel=await write(path.join(paths.models,'ggml-base.'+id+'.part')),freshModel=await write(path.join(paths.models,'ggml-large-v3-turbo-q5_0.'+id+'.part'));
 const staleCache=await write(path.join(cache,'a'.repeat(64)+'.json.'+id+'.tmp')),unknownTemp=await write(path.join(cache,'project.json.tmp'));
 await old(staleModel,3);await old(staleCache,3);await old(unknownTemp,3);await recoverScratch();
 assert.equal(await exists(path.join(dead,'.work')),false);assert.equal(await exists(path.join(dead,'audio.wav')),false);assert.equal(await exists(path.join(dead,'subtitled.partial.mp4')),false);
 for(const dir of [live,unknown])for(const name of ['.work/transcript.json','audio.wav','subtitled.partial.mp4'])assert.equal(await exists(path.join(dir,name)),true);
 for(const dir of [dead,live,unknown])for(const name of ['subtitled.mp4','project.json'])assert.equal(await fs.readFile(path.join(dir,name),'utf8'),'retained');
 assert.equal(await exists(staleModel),false);assert.equal(await exists(staleCache),false);for(const file of [freshModel,unknownTemp,input])assert.equal(await fs.readFile(file,'utf8'),'retained');
}));

test('atomic JSON rename failure removes temporary file and preserves existing project',async t=>fixture(async root=>{
 const file=await write(path.join(root,'projects','project.json'),JSON.stringify({important:'original'}));
 const original=fs.rename;t.mock.method(fs,'rename',async(from,to)=>{if(to===file)throw Object.assign(new Error('rename denied'),{code:'EACCES'});return original(from,to)});
 await assert.rejects(service.saveJSON(file,{important:'replacement'}),/rename denied/);assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),{important:'original'});assert.deepEqual(await fs.readdir(path.dirname(file)),['project.json']);
}));

test('batch success, stage failure and cancellation all remove .work but keep source inputs and completed outputs',async()=>fixture(async root=>{
 const input=await write(path.join(root,'inputs','one.mp4'),'original-input');const cues=[{id:1,start:0,end:1,text:'source',translation:'译文'}];
 for(const outcome of ['completed','failed','cancelled']){
  const controller=new AbortController();const deps={saveJSON:service.saveJSON,probe:async file=>({path:file,duration:1}),transcribe:async(media,options,dest)=>{
   await write(path.join(dest,'audio.wav'),'temporary');await write(path.join(dest,'transcript.txt'),'source');
   if(outcome==='failed')throw new Error('ASR failure');if(outcome==='cancelled'){controller.abort();throw Object.assign(new Error('cancelled'),{name:'AbortError'})}return {cues};
  },translate:async()=>({cues}),exportSubtitles:async(data,dest)=>({files:[{path:await write(path.join(dest,'source.srt'),'subtitles')}]}),burn:async(data,context,dest)=>({path:await write(path.join(dest,'subtitled.mp4'),'finished-video')})};
  if(outcome==='cancelled')await assert.rejects(runBatch({workspaceRoot:root,preset:structuredClone(builtinPreset)},{signal:controller.signal},deps),{name:'AbortError'});
  else{const result=await runBatch({workspaceRoot:root,preset:structuredClone(builtinPreset)},{signal:controller.signal},deps);assert.equal(result[outcome],1)}
 }
 const outputs=await fs.readdir(paths.outputs);assert.equal(outputs.length,3);let videos=0;
 for(const name of outputs){const dir=path.join(paths.outputs,name);assert.equal(await exists(path.join(dir,'.work')),false);if(await exists(path.join(dir,'subtitled.mp4'))){videos++;assert.equal(await fs.readFile(path.join(dir,'subtitled.mp4'),'utf8'),'finished-video');assert.equal(await fs.readFile(path.join(dir,'transcript.txt'),'utf8'),'source')}}
 assert.equal(videos,1);assert.equal(await fs.readFile(input,'utf8'),'original-input');
}));

test('repeat SRT/ASS exports apply speech trim, gap fill and offset once while preserving raw project timings',async()=>fixture(async root=>{
 const cues=[{id:1,start:0,end:3,speechEnd:1.5,text:'first'},{id:2,start:1.6,end:4,speechEnd:2.6,text:'second'}];const original=structuredClone(cues);
 const style={...defaults.style,subtitleMode:'source',trimToSpeechEnd:true,endPaddingMs:100,endTrimMs:100,fillGapsMs:150,offset:.25};
 const data={cues,style,mode:'source'};const a=await service.exportSubtitles(data,path.join(root,'subtitles','first'));
 const b=await service.exportSubtitles({...data,cues:a.cues},path.join(root,'subtitles','second'));
 assert.deepEqual(cues,original);assert.deepEqual(a.cues,original);assert.deepEqual(b.cues,original);
 for(const name of ['source.srt','subtitles.ass'])assert.equal(await fs.readFile(path.join(a.folder,name),'utf8'),await fs.readFile(path.join(b.folder,name),'utf8'));
 assert.deepEqual(parseSrt(await fs.readFile(path.join(a.folder,'source.srt'))).map(c=>[c.start,c.end]),[[.25,1.85],[1.85,2.85]]);
 const ass=await fs.readFile(path.join(a.folder,'subtitles.ass'),'utf8');assert.match(ass,/0:00:00\.25,0:00:01\.85/);assert.match(ass,/0:00:01\.85,0:00:02\.85/);
 assert.deepEqual(JSON.parse(await fs.readFile(path.join(a.folder,'export-manifest.json'),'utf8')).cues,original);
}));

test('registered preview and live encoder stay protected even above cache budgets, then become reclaimable',async()=>fixture(async()=>{
 const base=path.join(paths.workspaceData,'previews'),registered=path.join(base,'registered'),encoding=path.join(base,'encoding'),idle=path.join(base,'idle');
 for(const dir of [registered,encoding,idle]){await write(path.join(dir,'.preview-cache'),'1');await write(path.join(dir,'preview.mp4'),'video');await old(dir,10)}
 const marker=await markScratch(encoding,'.encode-scratch');await old(encoding,10);
 setPreviewProtection(()=>[path.join(registered,'preview.mp4')]);
 try{
  const result=await pruneCache('previews',{maxCount:0,maxBytes:0,maxAgeMs:0});assert.equal(result.count,2);assert.equal(result.removed,1);
  assert.equal(await exists(registered),true);assert.equal(await exists(encoding),true);assert.equal(await exists(idle),false);
  setPreviewProtection(()=>[]);await fs.rm(marker);const released=await pruneCache('previews',{maxCount:0,maxBytes:0,maxAgeMs:0});assert.equal(released.count,0);assert.equal(released.removed,2);
 }finally{setPreviewProtection(()=>[])}
}));

test('crashed preview recovery immediately removes dead marked folders while preserving active, live and unrelated directories',async()=>fixture(async root=>{
 const exited=require('node:child_process').spawnSync(process.execPath,['-e',''],{windowsHide:true});assert.equal(exited.status,0);assert.throws(()=>process.kill(exited.pid,0),{code:'ESRCH'});
 const base=path.join(paths.workspaceData,'previews'),dead=path.join(base,'dead'),registered=path.join(base,'registered'),live=path.join(base,'live'),unmarked=path.join(base,'user-folder'),unknown=path.join(base,'unknown-owner');
 for(const dir of [dead,registered,live,unmarked,unknown]){
  await write(path.join(dir,'preview.partial.mp4'),'partial');
  await write(path.join(dir,'.encode-scratch'),JSON.stringify({owner:dir===unknown?'user':'subtitle-foundry',pid:dir===live?process.pid:exited.pid}));
  if(dir!==unmarked)await write(path.join(dir,'.preview-cache'),'1');
 }
 const output=await write(path.join(root,'outputs','finished','preview.mp4'),'finished');
 setPreviewProtection(()=>[path.join(registered,'preview.partial.mp4')]);
 try{
  await recoverScratch();assert.equal(await exists(dead),false);
  for(const dir of [registered,live,unmarked,unknown])assert.equal(await fs.readFile(path.join(dir,'preview.partial.mp4'),'utf8'),'partial');
  assert.equal(await fs.readFile(output,'utf8'),'finished');
  setPreviewProtection(()=>[]);await recoverScratch();assert.equal(await exists(registered),false);assert.equal(await exists(live),true);assert.equal(await exists(unmarked),true);assert.equal(await exists(unknown),true);
 }finally{setPreviewProtection(()=>[])}
}));

test('built-in preset migration fills missing timing fields and preserves explicit timing, colors and custom presets',async()=>fixture(async root=>{
 const timingKeys=['trimToSpeechEnd','endPaddingMs','endTrimMs','fillGapsMs','maxCueDuration'];const file=path.join(root,'presets',builtinPreset.id+'.json');
 const legacy=structuredClone(builtinPreset);legacy.name='Custom cinema name';legacy.settings.style.primaryColor='#123456';legacy.settings.style.secondaryColor='#654321';legacy.settings.style.font='Arial';legacy.settings.encode.quality=27;
 for(const key of timingKeys)delete legacy.settings.style[key];await fs.writeFile(file,JSON.stringify(legacy));
 const custom={...structuredClone(legacy),id:'my-custom-preset',name:'Independent preset'};const customFile=await write(path.join(root,'presets',custom.id+'.json'),JSON.stringify(custom));
 await initializeWorkspace(root);let migrated=JSON.parse(await fs.readFile(file,'utf8'));
 const expected=structuredClone(legacy);for(const key of timingKeys)expected.settings.style[key]=builtinPreset.settings.style[key];assert.deepEqual(migrated,expected);assert.equal(await fs.readFile(customFile,'utf8'),JSON.stringify(custom));
 // Explicit false/zero are settings, not missing values; preserve them during a partial migration.
 migrated.settings.style.trimToSpeechEnd=false;migrated.settings.style.endPaddingMs=0;migrated.settings.style.endTrimMs=0;migrated.settings.style.fillGapsMs=0;delete migrated.settings.style.maxCueDuration;
 await fs.writeFile(file,JSON.stringify(migrated));await initializeWorkspace(root);expected.settings.style={...migrated.settings.style,maxCueDuration:builtinPreset.settings.style.maxCueDuration};assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),expected);
 Object.assign(expected.settings.style,{trimToSpeechEnd:true,endPaddingMs:123,endTrimMs:45,fillGapsMs:345,maxCueDuration:7.5});await fs.writeFile(file,JSON.stringify(expected));
 const stable=await fs.readFile(file,'utf8');await initializeWorkspace(root);assert.equal(await fs.readFile(file,'utf8'),stable);assert(!(await fs.readdir(path.dirname(file))).some(name=>name.endsWith('.tmp')));
}));
