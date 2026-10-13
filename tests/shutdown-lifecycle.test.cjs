'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const Module=require('node:module');const {EventEmitter}=require('node:events');

test('main-process shutdown waits for accepted saves and rejects new IPC operations',async t=>{
 const {paths}=require('../electron/paths.cjs');const originalPaths={...paths};const envKeys=['TEMP','TMP','CUDA_CACHE_PATH'];const originalEnv=Object.fromEntries(envKeys.map(key=>[key,process.env[key]]));
 const fixture=await fs.mkdtemp(path.join(paths.temp,'shutdown-lifecycle-'));const mainPath=require.resolve('../electron/main.cjs');
 const storage=require('../electron/storage.cjs'),service=require('../electron/service.cjs'),workspace=require('../electron/workspace.cjs');
 let releaseWrite,enteredWrite,quitDone;const entered=new Promise(resolve=>{enteredWrite=resolve}),quit=new Promise(resolve=>{quitDone=resolve});let quitCalled=false;
 try{
  paths.workspace=path.join(fixture,'workspace');paths.outputs=path.join(paths.workspace,'outputs');paths.workspaceData=path.join(paths.workspace,'.subtitle-foundry');paths.data=path.join(fixture,'data');paths.temp=path.join(paths.data,'temp');
  await fs.mkdir(paths.workspaceData,{recursive:true});
  const originalSave=service.saveJSON;
  t.mock.method(service,'saveJSON',async(...args)=>{enteredWrite();await new Promise(resolve=>{releaseWrite=resolve});return originalSave(...args)});
  t.mock.method(workspace,'getWorkspace',async()=>({root:paths.workspace}));t.mock.method(storage,'maintainWorkspaceCaches',async()=>[]);
  const app=new EventEmitter();Object.assign(app,{setPath(){},commandLine:{appendSwitch(){}},whenReady:()=>Promise.resolve(),quit:()=>{quitCalled=true;quitDone()}});
  const handlers=new Map(),webContents=new EventEmitter();Object.assign(webContents,{setWindowOpenHandler(){},session:{setPermissionRequestHandler(){}},send(){}});
  class BrowserWindow{constructor(){this.webContents=webContents}async loadFile(){}isDestroyed(){return false}}
  const electron={app,BrowserWindow,ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},protocol:{registerSchemesAsPrivileged(){},handle(){}},Menu:{setApplicationMenu(){}},dialog:{},shell:{}};
  const originalLoad=Module._load;let main;
  try{Module._load=function(id,...rest){return id==='electron'?electron:originalLoad.call(this,id,...rest)};main=require(mainPath)}finally{Module._load=originalLoad}
  await new Promise(resolve=>setImmediate(resolve));
  const settings=structuredClone(require('../shared/defaults.cjs').defaults),event={sender:webContents};const saving=handlers.get('studio:saveSettings')(event,settings);
  await entered;assert.equal(main.getResourceStats().inFlightIpc,1);app.emit('before-quit',{preventDefault(){}});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(quitCalled,false,'quit must not preempt the accepted disk write');
  await assert.rejects(handlers.get('studio:defaults')(event),/关闭/);assert.equal(main.getResourceStats().inFlightIpc,1);
  releaseWrite();await saving;await quit;assert.equal(main.getResourceStats().inFlightIpc,0);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(paths.workspaceData,'settings.json'),'utf8')),settings);
 }finally{
  releaseWrite?.();delete require.cache[mainPath];storage.setPreviewProtection(()=>[]);Object.assign(paths,originalPaths);
  for(const key of envKeys){if(originalEnv[key]===undefined)delete process.env[key];else process.env[key]=originalEnv[key]}
  assert(path.relative(originalPaths.temp,fixture).startsWith('shutdown-lifecycle-'));await fs.rm(fixture,{recursive:true,force:true});
 }
});
