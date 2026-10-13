const {app,BrowserWindow,ipcMain,dialog,protocol,Menu,shell}=require('electron');
const fs=require('node:fs');const fsp=fs.promises;const path=require('node:path');
const {paths,assertInside,folder}=require('./paths.cjs');
for(const name of ['appData','userData','sessionData','temp','logs','crashDumps']){const dir=assertInside(path.join(paths.data,name));fs.mkdirSync(dir,{recursive:true});app.setPath(name,dir)}
process.env.TEMP=paths.temp;process.env.TMP=paths.temp;process.env.CUDA_CACHE_PATH=path.join(paths.data,'cuda-cache');
app.commandLine.appendSwitch('disk-cache-dir',path.join(paths.data,'chromium-cache'));
app.commandLine.appendSwitch('disk-cache-size','67108864');
app.commandLine.appendSwitch('disable-crash-reporter');app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
protocol.registerSchemesAsPrivileged([{scheme:'media',privileges:{standard:true,secure:true,stream:true,supportFetchAPI:true,corsEnabled:true}}]);
const {defaults}=require('../shared/defaults.cjs');const service=require('./service.cjs');const {Jobs}=require('./jobs.cjs');const {parseSrt,normalizeCues}=require('./core/subtitles.cjs');
const workspace=require('./workspace.cjs');const {runBatch}=require('./batch.cjs');const {normalizePreset}=require('../shared/workflow.cjs');
const {MediaRegistry}=require('./media.cjs');const {maintainWorkspaceCaches,setPreviewProtection}=require('./storage.cjs');const {terminateAll,activeProcessCount}=require('./core/process.cjs');
let win,closing=false,closed=false;const pendingIpc=new Set();const mediaRegistry=new MediaRegistry();
setPreviewProtection(()=>[...mediaRegistry.files.values()]);
function mediaUrl(file){return mediaRegistry.register(file);}
async function mediaInfo(file){if(closing)throw new Error('应用正在关闭');const info=await service.probe(file);return {...info,url:mediaUrl(info.path)}}
const jobs=new Jobs(job=>{if(job.result?.path&&['preview','burn'].includes(job.kind))job.result.url=mediaUrl(job.result.path);if(win&&!win.isDestroyed())win.webContents.send('studio:job',job)});
function handle(name,fn){ipcMain.handle('studio:'+name,async(event,...args)=>{
 if(event.sender!==win?.webContents)throw new Error('未授权的窗口');
 if(closing)throw new Error('应用正在关闭，无法执行新操作');
 const operation=Promise.resolve().then(()=>fn(...args));pendingIpc.add(operation);
 try{return await operation}finally{pendingIpc.delete(operation)}
})}
async function waitForIpc(timeoutMs){
 if(!pendingIpc.size)return true;
 let timer;try{return await Promise.race([Promise.allSettled([...pendingIpc]).then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),timeoutMs)})])}finally{clearTimeout(timer)}
}
function requireCues(cues){return normalizeCues(cues)}
async function pickSrt(encoding){const {canceled,filePaths}=await dialog.showOpenDialog(win,{properties:['openFile'],filters:[{name:'SubRip 字幕',extensions:['srt']}]});if(canceled)return null;const data=await fsp.readFile(filePaths[0]);let content=data;if(encoding==='gb18030')content=new TextDecoder('gb18030',{fatal:true}).decode(data);else if(encoding==='utf16le')content=data.toString('utf16le');return {cues:parseSrt(content),path:filePaths[0]}}
function projectData(project){if(!project||typeof project!=='object'||!project.settings)throw new Error('无效项目：请打开通过“保存项目”生成的 project.json');return {version:1,portableRoot:paths.root,workspaceRoot:paths.workspace,media:project.media||null,cues:project.cues?.length?requireCues(project.cues):[],settings:normalizePreset({version:1,id:'project-settings',name:'项目设置',settings:project.settings}).settings,lastExport:project.lastExport}}
async function restore(project){if(!project)return null;const p=projectData(project);const oldRoot=project.portableRoot;
 const relocate=file=>{if(!file)return file;for(const [from,to]of [[project.workspaceRoot,paths.workspace],[oldRoot,paths.root]]){if(!from)continue;const rel=path.relative(from,file);if(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel)){const candidate=path.join(to,rel);if(fs.existsSync(candidate))return candidate}}return file};
 if(p.media){try{p.media=await mediaInfo(relocate(p.media.path))}catch{p.media=null}}
 if(p.lastExport){p.lastExport.folder=relocate(p.lastExport.folder);p.lastExport.files=p.lastExport.files.map(f=>({...f,path:relocate(f.path)}))}return p}
handle('status',()=>service.status());handle('defaults',()=>structuredClone(defaults));
function requireIdle(){if(jobs.list().some(job=>job.status==='running'))throw new Error('请等待当前任务完成或取消后再切换工作文件夹。');}
handle('getWorkspace',()=>workspace.getWorkspace());handle('reloadWorkspace',()=>workspace.reloadWorkspace());
handle('chooseWorkspace',async()=>{requireIdle();const result=await dialog.showOpenDialog(win,{title:'选择工作文件夹',defaultPath:paths.workspace,properties:['openDirectory','createDirectory']});if(result.canceled)return null;requireIdle();return workspace.selectWorkspace(result.filePaths[0]);});
handle('saveWorkflowPreset',input=>workspace.saveWorkflowPreset(input));
handle('startBatch',async({presetId})=>{requireIdle();const info=await workspace.reloadWorkspace();const preset=info.presets.find(p=>p.id===presetId);if(!preset)throw new Error('预设不存在或格式有误，请刷新预设列表。');return jobs.start('batch',ctx=>runBatch({workspaceRoot:info.root,preset:normalizePreset(preset)},ctx));});
handle('chooseVideo',async()=>{const r=await dialog.showOpenDialog(win,{properties:['openFile'],filters:[{name:'视频',extensions:['mp4','mkv','mov','webm','avi','m4v','wmv','ts','m2ts']}]});return r.canceled?null:mediaInfo(r.filePaths[0])});
handle('sampleVideo',()=>fs.existsSync(path.join(paths.root,'final_video.mp4'))?mediaInfo(path.join(paths.root,'final_video.mp4')):null);
handle('probe',mediaInfo);handle('chooseSubtitles',pickSrt);handle('chooseTranslation',pickSrt);
handle('startTranscribe',({media,options})=>jobs.start('transcribe',ctx=>service.transcribe(media,options,folder('transcript'),ctx)));
handle('startTranslate',({cues,options})=>jobs.start('translate',ctx=>service.translate(cues,options,ctx)));
handle('exportSubtitles',input=>service.exportSubtitles(input));handle('startBurn',input=>jobs.start(input.preview?'preview':'burn',ctx=>service.burn(input,ctx)));
handle('downloadModel',id=>jobs.start('download',ctx=>service.downloadModel(id,ctx)));handle('cancelJob',id=>jobs.cancel(id));handle('getJobs',()=>jobs.list());
handle('saveSettings',settings=>service.saveJSON(path.join(paths.workspaceData,'settings.json'),normalizePreset({version:1,id:'settings',name:'当前设置',settings}).settings));handle('loadSettings',async()=>{const settings=await service.readJSON(path.join(paths.workspaceData,'settings.json'));return settings?normalizePreset({version:1,id:'settings',name:'当前设置',settings}).settings:null;});
handle('saveProject',async project=>{const p=projectData(project);const name=path.join(folder('project',path.join(paths.workspace,'projects')),'project.json');await service.saveJSON(name,p);await service.saveJSON(path.join(paths.workspaceData,'last-project.json'),p);return name});
handle('loadProject',async()=>{const r=await dialog.showOpenDialog(win,{defaultPath:path.join(paths.workspace,'projects'),filters:[{name:'字幕工坊项目',extensions:['json']}],properties:['openFile']});if(r.canceled)return null;const p=await restore(await service.readJSON(r.filePaths[0]));await service.saveJSON(path.join(paths.workspaceData,'last-project.json'),p);return p});
handle('loadLastProject',async()=>restore(await service.readJSON(path.join(paths.workspaceData,'last-project.json'))));
handle('reveal',async file=>{assertInside(file);const stat=await fsp.stat(file);if(stat.isDirectory()){const error=await shell.openPath(file);if(error)throw new Error(error)}else shell.showItemInFolder(file)});
handle('openOutput',async file=>{assertInside(file);if(!['.mp4','.mkv','.mov','.webm','.srt','.ass','.txt','.json'].includes(path.extname(file).toLowerCase()))throw new Error('不支持打开此文件');await fsp.access(file);const error=await shell.openPath(file);if(error)throw new Error(error)});
handle('mediaUrl',file=>{assertInside(file);return mediaUrl(file)});
handle('releaseMedia',url=>{mediaRegistry.release(url);});
app.whenReady().then(async()=>{
 await workspace.getWorkspace();
 await maintainWorkspaceCaches();
 protocol.handle('media',request=>mediaRegistry.response(request));
 Menu.setApplicationMenu(null);win=new BrowserWindow({width:1540,height:1010,minWidth:1100,minHeight:740,backgroundColor:'#151A1D',title:'字幕工坊 · Subtitle Foundry',show:!process.argv.includes('--headless-test'),webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
 win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',e=>e.preventDefault());win.webContents.session.setPermissionRequestHandler((_w,_p,callback)=>callback(false));
 await win.loadFile(path.join(paths.root,'dist','index.html'));
 if(process.argv.includes('--smoke-test')){const report={paths:Object.fromEntries(['appData','userData','sessionData','temp','logs','crashDumps'].map(n=>[n,app.getPath(n)])),status:await service.status(),title:await win.webContents.executeJavaScript('document.title')};await service.saveJSON(path.join(paths.data,'electron-smoke.json'),report);app.quit()}
}).catch(error=>{fs.writeFileSync(path.join(paths.data,'startup-error.txt'),String(error.stack||error));app.quit()});
app.on('before-quit',event=>{
 if(closed)return;event.preventDefault();if(closing)return;closing=true;mediaRegistry.dispose();
 (async()=>{
  // Stop new jobs immediately, while accepted saves/exports get time to finish.
  await Promise.all([jobs.dispose(8000),waitForIpc(8000)]);
  const childrenStopped=await terminateAll(4000);
  const [idle,ipcIdle]=await Promise.all([jobs.waitForIdle(4000),waitForIpc(4000)]);
  if(!childrenStopped||!idle||!ipcIdle)throw new Error(`关闭超时：${pendingIpc.size} 个操作尚未结束，最近的保存可能未完成；已标记临时文件会在下次启动时尝试恢复清理`);
  let maintenanceTimer;try{const warnings=await Promise.race([maintainWorkspaceCaches(),new Promise((_,reject)=>{maintenanceTimer=setTimeout(()=>reject(new Error('关闭时缓存维护超时，下次启动时将重新检查')),4000)})]);if(warnings.length)throw new Error(warnings.join('\n'));}finally{clearTimeout(maintenanceTimer)}
 })().catch(error=>{try{fs.writeFileSync(path.join(paths.data,'shutdown-error.txt'),String(error.message||error));}catch{}}).finally(async()=>{
  // An already accepted handler can finish an await and spawn during shutdown.
  try{if(activeProcessCount()&&!await terminateAll(1000))throw new Error('关闭时仍有外部程序未确认退出，请检查任务管理器')}catch(error){try{fs.writeFileSync(path.join(paths.data,'shutdown-error.txt'),String(error.message||error));}catch{}}
  finally{closed=true;app.quit()}
 });
});
app.on('window-all-closed',()=>app.quit());
module.exports={getResourceStats:()=>({media:mediaRegistry.stats(),jobs:jobs.jobs.size,controllers:jobs.controllers.size,pending:jobs.pending.size,inFlightIpc:pendingIpc.size,subprocesses:activeProcessCount()})};
