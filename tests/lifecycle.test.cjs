'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const fsp=fs.promises;const path=require('node:path');const crypto=require('node:crypto');
const {paths}=require('../electron/paths.cjs');const {Jobs,MAX_JOBS}=require('../electron/jobs.cjs');const {run,terminateAll,activeProcessCount}=require('../electron/core/process.cjs');const {downloadModel}=require('../electron/core/models.cjs');const {translateCues}=require('../electron/core/deepseek.cjs');
async function fixture(action){const root=await fsp.mkdtemp(path.join(paths.temp,'lifecycle-test-'));const old={workspaceData:paths.workspaceData,models:paths.models};try{paths.workspaceData=root;paths.models=root;await action(root)}finally{Object.assign(paths,old);assert(path.relative(paths.temp,root).startsWith('lifecycle-test-'));await fsp.rm(root,{recursive:true,force:true})}}

test('hundreds of job completions retain bounded history without subtitle arrays',async()=>fixture(async root=>{
 let delivered=0;const jobs=new Jobs(job=>{if(job.status==='completed'){assert.equal(job.result.cues.length,1000);delivered++}});
 for(let i=0;i<150;i++){jobs.start('transcribe',async()=>({folder:`folder-${i}`,cues:Array.from({length:1000},(_,id)=>({id,text:'字幕'}))}));assert.equal(await jobs.waitForIdle(),true)}
 assert.equal(delivered,150);assert.equal(jobs.jobs.size,MAX_JOBS);assert.equal(jobs.controllers.size,0);assert.equal(jobs.pending.size,0);assert.equal(jobs.lastPublish.size,0);
 assert(jobs.list().every(job=>!job.result.cues));assert.equal(JSON.parse(await fsp.readFile(path.join(root,'job-history.json'),'utf8')).length,MAX_JOBS);await jobs.dispose();
}));

test('progress is throttled and publisher/storage errors do not strand controllers',async t=>fixture(async()=>{
 let writes=0,publishes=0,errors=0;const original=fs.writeFileSync;
 t.mock.method(fs,'writeFileSync',(...args)=>{writes++;return original(...args)});
 const jobs=new Jobs(()=>{publishes++;throw new Error('renderer closed')},{progressIntervalMs:60000,historyIntervalMs:60000,onError:()=>{errors++}});
 jobs.start('test',async({onProgress})=>{for(let i=0;i<10000;i++)onProgress({progress:i/100});return {path:'out.mp4'}});
 await jobs.waitForIdle();assert.equal(publishes,2);assert.equal(writes,2);assert.equal(errors,2);assert.equal(jobs.controllers.size,0);assert.equal(jobs.list()[0].status,'completed');
 t.mock.method(fs,'writeFileSync',()=>{throw new Error('disk full')});jobs.start('test',async()=>{throw new Error('task failure')});await jobs.waitForIdle();assert.equal(jobs.controllers.size,0);assert.equal(jobs.list()[0].status,'failed');await jobs.dispose();
}));

test('dispose cancels active work, waits for cleanup and prevents starts',async()=>fixture(async()=>{
 const jobs=new Jobs(()=>{});let started;const ready=new Promise(resolve=>{started=resolve});let cleaned=false;
 jobs.start('test',async({signal})=>{started();await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));await new Promise(resolve=>setTimeout(resolve,10));cleaned=true});
 await ready;assert.equal(await jobs.dispose(),true);assert.equal(cleaned,true);assert.equal(jobs.controllers.size,0);assert.equal(jobs.pending.size,0);assert.equal(jobs.list()[0].status,'cancelled');assert.throws(()=>jobs.start('test',async()=>{}),/关闭/);
}));

test('cancelled batch publishes settled item states and keeps compact results',async()=>fixture(async()=>{
 let ready;const started=new Promise(resolve=>{ready=resolve});const events=[];const jobs=new Jobs(job=>events.push(structuredClone(job)));
 const id=jobs.start('batch',async({signal,onProgress})=>{
  const items=[{input:'one.mp4',status:'running'},{input:'two.mp4',status:'pending'}];
  onProgress({batch:{presetName:'fixture',items:structuredClone(items),current:1,total:2}});ready();
  await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
  for(const item of items)item.status='cancelled';items[0].cleanupWarning='cleanup retry';
  onProgress({batch:{presetName:'fixture',items,current:1,total:2}});
  const error=new DOMException('cancelled','AbortError');error.result={presetName:'fixture',items,completed:0,failed:0,cancelled:2};throw error;
 });
 await started;jobs.cancel(id);await jobs.waitForIdle();
 const job=jobs.list()[0];assert.equal(job.status,'cancelled');assert(job.batch.items.every(item=>item.status==='cancelled'));assert.equal(job.batch.items[0].cleanupWarning,'cleanup retry');
 assert.equal(job.result.cancelled,2);assert.equal(job.result.items,undefined);assert.equal(events.at(-1).result.items.length,2);assert.equal(jobs.controllers.size,0);await jobs.dispose();
}));

test('repeated cancellations settle after OS child termination and remove abort listeners',async()=>{
 const {getEventListeners}=require('node:events');
 for(let i=0;i<4;i++){
  const controller=new AbortController();let pid;
  await assert.rejects(run(process.execPath,['-e','process.stdout.write(String(process.pid));setInterval(()=>{},1000)'],{signal:controller.signal,onOutput:text=>{pid=Number(text);controller.abort()}}),{name:'AbortError'});
  assert.equal(activeProcessCount(),0);assert.equal(getEventListeners(controller.signal,'abort').length,0);assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
 }
 let ready;const started=new Promise(resolve=>{ready=resolve});const task=run(process.execPath,['-e','process.stdout.write("ready");setInterval(()=>{},1000)'],{onOutput:()=>ready()});const rejection=assert.rejects(task,/执行失败/);
 await started;assert.equal(await terminateAll(),true);await rejection;assert.equal(activeProcessCount(),0);
});

test('model HTTP errors, callback failure and file-open failure cancel bodies and remove partials',async t=>fixture(async root=>{
 let cancelled=0;const body=()=>new ReadableStream({start(controller){controller.enqueue(new Uint8Array([1,2,3]))},cancel(){cancelled++}});
 t.mock.method(globalThis,'fetch',async()=>new Response(body(),{status:500}));await assert.rejects(downloadModel('base'),/HTTP 500/);assert.equal(cancelled,1);
 t.mock.method(globalThis,'fetch',async()=>new Response(body()));await assert.rejects(downloadModel('base',{onProgress(){throw new Error('progress failed')}}),/progress failed/);assert.equal(cancelled,2);assert.deepEqual(await fsp.readdir(root),[]);
 t.mock.method(fsp,'open',async()=>{throw new Error('open failed')});await assert.rejects(downloadModel('base'),/open failed/);assert.equal(cancelled,3);assert.deepEqual(await fsp.readdir(root),[]);
}));

test('model rename failures close the file and remove the verified partial',async t=>fixture(async root=>{
 // Mock the large payload/writes but use a real partial file to verify cleanup after rename.
 const originalOpen=fsp.open;let closed=false;
 t.mock.method(fsp,'open',async(...args)=>{const file=await originalOpen(...args);return {write:async(value,offset,length)=>({bytesWritten:length}),close:async()=>{await file.close();closed=true}}});
 t.mock.method(crypto,'createHash',()=>({update(){},digest(){return '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe'}}));
 t.mock.method(globalThis,'fetch',async()=>({ok:true,body:new ReadableStream({start(controller){controller.enqueue({length:147951465});controller.close()}})}));
 t.mock.method(fsp,'rename',async()=>{throw new Error('rename failed')});
 await assert.rejects(downloadModel('base'),/rename failed/);assert.equal(closed,true);assert.deepEqual(await fsp.readdir(root),[]);
}));

test('DeepSeek error and oversized response streams are cancelled with listeners released',async()=>{
 const previous=process.env.Deepseek;process.env.Deepseek='lifecycle-test-key';
 const controller=new AbortController();const {getEventListeners}=require('node:events');let cancelled=0;
 const cues=[{id:1,start:0,end:1,text:'test'}];const options={mode:'translation'};const runtime={signal:controller.signal,retryDelayMs:0,minIntervalMs:0};
 try{
  await assert.rejects(translateCues(cues,options,{...runtime,fetchImpl:async()=>new Response(new ReadableStream({cancel(){cancelled++}}),{status:401})}),/密钥无效/);assert.equal(cancelled,1);
  await assert.rejects(translateCues(cues,options,{...runtime,fetchImpl:async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(2*1024*1024+1))},cancel(){cancelled++}}))}),/大小限制/);assert.equal(cancelled,2);assert.equal(getEventListeners(controller.signal,'abort').length,0);
 }finally{if(previous===undefined)delete process.env.Deepseek;else process.env.Deepseek=previous}
});
