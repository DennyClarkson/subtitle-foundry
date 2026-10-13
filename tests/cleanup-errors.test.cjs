'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');const {createRequire}=require('node:module');
const {defaults}=require('../shared/defaults.cjs');const {builtinPreset}=require('../shared/workflow.cjs');
const absent=()=>Object.assign(new Error('missing'),{code:'ENOENT'});
const locked=()=>Object.assign(new Error('temporary file locked'),{code:'EPERM'});
function load(relative,mocks){
 const filename=path.join(__dirname,'..',relative),requireFrom=createRequire(filename),module={exports:{}};
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module,require:name=>Object.hasOwn(mocks,name)?mocks[name]:requireFrom(name),process,Buffer,structuredClone},{filename});
 return module.exports;
}
function serviceFixture({primary,cleanupFailure=true,tempPresent=false,statFailure,renameFailure,preview=false}={}){
 const removed=[],files=new Set(tempPresent?[path.join('job','audio.wav')]:[]);
 const fsp={mkdir:async()=>{},writeFile:async file=>{files.add(file);},
  lstat:async file=>{if(statFailure)throw statFailure;if(!files.has(file))throw absent();return {};},
  rename:async(from,to)=>{if(renameFailure)throw renameFailure;files.delete(from);files.add(to);},
  rm:async file=>{removed.push(file);if(cleanupFailure)throw cleanupFailure===true?locked():cleanupFailure;files.delete(file);}};
 const paths={workspace:'workspace',workspaceData:'cache',outputs:'outputs',ffmpeg:'ffmpeg'};
 const service=load('electron/service.cjs',{
  'node:fs':{promises:fsp},'./paths.cjs':{paths,assertInside:file=>file,folder:()=> 'job'},
  './core/asr.cjs':{transcribe:async()=>{if(primary)throw primary;return {cues:[]};}},
  './core/process.cjs':{run:async()=>{files.add(path.join('job',preview?'preview.partial.mp4':'subtitled.partial.mp4'));if(primary)throw primary;}},
  './storage.cjs':{markScratch:async(dir,name)=>{const file=path.join(dir,name);files.add(file);return file;},pruneCache:async()=>{},removeScratch:async()=>{files.delete(path.join('job','.preview-cache'));files.delete(path.join('job','.encode-scratch'));throw locked();}}
 });
 return {service,removed,files};
}

test('ASR service retains its original failure and only removes marker after confirmed WAV absence',async()=>{
 const primary=new Error('Whisper failed'),cleanup=locked();
 const failed=serviceFixture({primary,cleanupFailure:cleanup});
 await assert.rejects(failed.service.transcribe({}, {}, 'job'),error=>error===primary);
 assert.deepEqual(failed.removed,[path.join('job','.asr-scratch')]);
 const success=serviceFixture({cleanupFailure:cleanup});
 await assert.rejects(success.service.transcribe({}, {}, 'job'),error=>error===cleanup);
 for(const options of [{tempPresent:true},{statFailure:Object.assign(new Error('denied'),{code:'EACCES'})}]){
  const f=serviceFixture({primary,...options});
  await assert.rejects(f.service.transcribe({}, {}, 'job'),error=>error===primary);
  assert.equal(f.removed.length,0);
 }
});

test('burn keeps encoder failure and recovery marker when partial deletion fails; successful encode reports cleanup failure',async()=>{
 const input={media:{path:'video.mp4',duration:2},cues:[{id:1,start:0,end:1,text:'hello'}],style:{...defaults.style,subtitleMode:'source'},encode:defaults.encode};
 const primary=Object.assign(new Error('encoding cancelled'),{name:'AbortError'}),cleanup=locked();
 const failed=serviceFixture({primary,cleanupFailure:cleanup});
 await assert.rejects(failed.service.burn(input,{},'job'),error=>error===primary);
 assert.equal(failed.files.has(path.join('job','.encode-scratch')),true);
 assert.deepEqual(failed.removed,[path.join('job','subtitled.partial.mp4')]);
 const success=serviceFixture({cleanupFailure:cleanup});
 await assert.rejects(success.service.burn(input,{},'job'),error=>error===cleanup);
 assert.equal(success.files.has(path.join('job','subtitled.mp4')),true);
 const preview=serviceFixture({primary,cleanupFailure:cleanup,preview:true});
 await assert.rejects(preview.service.burn({...input,preview:true},{},'job'),error=>error===primary);
 assert.equal(preview.files.has(path.join('job','.preview-cache')),true);
 assert.equal(preview.files.has(path.join('job','.encode-scratch')),true);
});

test('atomic JSON cleanup does not replace a rename failure',async()=>{
 const primary=new Error('disk full'),cleanup=locked();
 const failed=serviceFixture({renameFailure:primary,cleanupFailure:cleanup});
 await assert.rejects(failed.service.saveJSON('project.json',{ok:true}),error=>error===primary);
 const success=serviceFixture({cleanupFailure:cleanup});
 await assert.rejects(success.service.saveJSON('project.json',{ok:true}),error=>error===cleanup);
});

function batchFixture({firstFailure,cancel=false,warningPersistenceFailure=false}={}){
 const root=path.resolve('mock-workspace'),events=[],saved=[];let folders=0;
 const batch=load('electron/batch.cjs',{
  'node:fs/promises':{mkdir:async()=>{},copyFile:async()=>{throw absent();}},
  './paths.cjs':{paths:{workspace:root,root},assertInside:file=>file,folder:(_name,base)=>path.join(base,String(++folders))},
  './workspace.cjs':{scanInputs:async()=>[1,2].map(i=>({path:path.join(root,'inputs',`${i}.mp4`),relativePath:`${i}.mp4`}))},
  './storage.cjs':{markScratch:async()=>{},pruneCache:async()=>{},removeScratch:async()=>{throw locked();}}
 });
 const dependencies={
  probe:async file=>{if(file.endsWith('1.mp4')&&firstFailure)throw Object.assign(new Error(firstFailure),cancel?{name:'AbortError'}:{});return {path:file};},
  transcribe:async()=>({cues:[{id:1,start:0,end:1,text:'hello'}]}),translate:async cues=>({cues}),
  exportSubtitles:async()=>({files:[{label:'source',path:'source.srt'}]}),burn:async(_input,_context,dest)=>({path:path.join(dest,'subtitled.mp4')}),
  saveJSON:async(file,value)=>{if(warningPersistenceFailure&&(value.cleanupWarning||value.items?.some(item=>item.cleanupWarning)))throw new Error('cannot save warning');saved.push({file,value:structuredClone(value)});}
 };
 return {events,saved,run:preset=>batch.runBatch({workspaceRoot:root,preset:preset||builtinPreset},{onProgress:event=>events.push(event)},dependencies)};
}

test('batch cleanup warnings preserve successful outputs, details and continue-on-error failures',async()=>{
 const f=batchFixture({firstFailure:'broken input'});const result=await f.run();
 assert.equal(result.failed,1);assert.equal(result.completed,1);
 assert.equal(result.items[0].error,'broken input');
 assert.ok(result.items.every(item=>item.cleanupWarning.includes('临时文件清理失败')));
 const completed=f.saved.filter(entry=>entry.file.endsWith('workflow.json')&&entry.value.status==='completed').at(-1).value;
 assert.ok(completed.output.endsWith('subtitled.mp4'));assert.equal(completed.files[0].path,'source.srt');assert.ok(completed.cleanupWarning);
 assert.match(f.events.at(-1).message,/2 项临时文件清理警告/);
 const allSuccess=batchFixture();assert.equal((await allSuccess.run()).completed,2);
 const stop=batchFixture({firstFailure:'broken input'}),preset=structuredClone(builtinPreset);preset.batch.continueOnError=false;
 const stopped=await stop.run(preset);assert.equal(stopped.failed,1);assert.equal(stopped.cancelled,1);
});

test('batch cleanup and warning persistence cannot replace cancellation or primary item errors',async()=>{
 const cancelled=batchFixture({firstFailure:'cancelled upstream',cancel:true,warningPersistenceFailure:true});
 await assert.rejects(cancelled.run(),error=>error.name==='AbortError'&&error.result.cancelled===2&&error.result.items[0].error==='cancelled upstream'&&error.result.items[0].cleanupWarning.includes('无法保存清理警告'));
 const failed=batchFixture({firstFailure:'original failure',warningPersistenceFailure:true});
 // Isolate one failed item: stop-on-error retains the original result even if
 // both warning persistence and the final manifest write fail.
 const preset=structuredClone(builtinPreset);preset.batch.continueOnError=false;
 const result=await failed.run(preset);assert.equal(result.items[0].error,'original failure');assert.equal(result.failed,1);
 const success=batchFixture({warningPersistenceFailure:true});
 await assert.rejects(success.run(),/cannot save warning/);
});
