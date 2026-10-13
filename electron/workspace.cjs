const fs = require('node:fs/promises');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {paths, assertInside, setWorkspaceRoot} = require('./paths.cjs');
const {builtinPreset, normalizePreset} = require('../shared/workflow.cjs');

const VIDEO_EXTENSIONS = new Set(['.mp4','.mkv','.mov','.webm','.avi','.m4v','.wmv','.ts','.m2ts','.mts','.mpeg','.mpg']);
const DIRECTORIES = ['inputs','subtitles','presets','outputs','projects','.subtitle-foundry'];
let initialized = false;
let initialization;
let workspaceWarning;
function locations(root) {
 return {root, inputs:path.join(root,'inputs'), subtitles:path.join(root,'subtitles'), presetsDir:path.join(root,'presets'), outputs:path.join(root,'outputs'), projects:path.join(root,'projects')};
}
async function atomicJSON(file, value, {exclusive=false}={}) {
 const tmp = file + '.' + randomUUID() + '.tmp';
 assertInside(file); assertInside(tmp);
 try {
  await fs.writeFile(tmp, JSON.stringify(value,null,2)+'\n', {flag:'wx'});
  if(exclusive) await fs.copyFile(tmp,file,require('node:fs').constants.COPYFILE_EXCL);
  else await fs.rename(tmp,file);
 } finally { await fs.rm(tmp,{force:true}); }
}
async function scanInputs(root, recursive=false) {
 const inputRoot=assertInside(path.join(root,'inputs'),root), videos=[];
 async function visit(dir) {
  for(const entry of await fs.readdir(dir,{withFileTypes:true})) {
   if(entry.isSymbolicLink()) continue;
   const file=assertInside(path.join(dir,entry.name),inputRoot);
   // lstat again also excludes junctions swapped in since directory enumeration.
   const stat=await fs.lstat(file); if(stat.isSymbolicLink()) continue;
   if(stat.isDirectory()) {if(recursive) await visit(file);continue;}
   if(stat.isFile()&&VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) videos.push({path:file,name:entry.name,relativePath:path.relative(inputRoot,file),size:stat.size});
  }
 }
 await visit(inputRoot);
 return videos.sort((a,b)=>a.relativePath.localeCompare(b.relativePath,'en',{numeric:true}));
}
async function workspaceInfo(root=paths.workspace) {
 root=assertInside(root,root);
 const info={...locations(root),presets:[],presetErrors:[],videos:[],...(workspaceWarning?{warning:workspaceWarning}:{})};
 assertInside(info.presetsDir,root);
 for(const entry of (await fs.readdir(info.presetsDir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
  if(!entry.name.toLowerCase().endsWith('.json')) continue;
  const file=path.join(info.presetsDir,entry.name);
  try {
   if(entry.isSymbolicLink()||!entry.isFile()) throw new Error('预设必须是工作区中的普通 JSON 文件');
   assertInside(file,info.presetsDir);
   const stat=await fs.lstat(file);if(stat.isSymbolicLink()||stat.size>1024*1024)throw new Error('预设文件无效或超过 1 MB');
   const preset=normalizePreset(JSON.parse((await fs.readFile(file,'utf8')).replace(/^\uFEFF/,'')));
   if(info.presets.some(p=>p.id===preset.id))throw new Error('预设 ID 重复');
   info.presets.push(preset);
  } catch(error) {info.presetErrors.push({file,error:error.message});}
 }
 info.videos=await scanInputs(root,true);
 return info;
}
async function initializeWorkspace(root) {
 root=path.resolve(root);
 const previous=paths.workspace;
 try {
  await fs.mkdir(root,{recursive:true});await setWorkspaceRoot(root);
  // Validate every existing managed child before creating or seeding anything.
  for(const name of DIRECTORIES)assertInside(path.join(paths.workspace,name),paths.workspace);
  for(const name of DIRECTORIES)await fs.mkdir(assertInside(path.join(paths.workspace,name),paths.workspace),{recursive:true});
  const preset=normalizePreset(structuredClone(builtinPreset));
  const file=assertInside(path.join(paths.workspace,'presets',preset.id+'.json'),paths.workspace);
  try {await atomicJSON(file,preset,{exclusive:true});}catch(error){if(error.code!=='EEXIST')throw error;}
  // Upgrade only newly introduced timing fields of our existing built-in preset.
  // User colors, fonts, encoding, names and explicitly chosen timing stay intact.
  try{
   const prior=JSON.parse((await fs.readFile(file,'utf8')).replace(/^\uFEFF/,''));
   if(prior.id===builtinPreset.id&&prior.settings?.style){let changed=false;
    for(const key of ['trimToSpeechEnd','endPaddingMs','endTrimMs','fillGapsMs','maxCueDuration'])if(prior.settings.style[key]===undefined){prior.settings.style[key]=builtinPreset.settings.style[key];changed=true;}
    if(changed){normalizePreset(prior);await atomicJSON(file,prior);}
   }
  }catch(error){if(error.code&&error.code!=='ENOENT')throw error;}
  const info=await workspaceInfo(paths.workspace);initialized=true;return info;
 } catch(error){if(previous)await setWorkspaceRoot(previous);throw error;}
}
async function getWorkspace() {
 if(initialized)return workspaceInfo(paths.workspace);
 if(initialization)return initialization;
 initialization=(async()=>{
  const localRoot=path.join(paths.root,'workspace');let root=localRoot;
  try {
   const saved=JSON.parse(await fs.readFile(assertInside(path.join(paths.data,'workspace.json')),'utf8'));
   if(typeof saved.root!=='string'||!saved.root.trim())throw new Error('保存的工作目录路径无效');
   root=saved.root;await fs.access(root);
  } catch(error){if(error.code!=='ENOENT'||root!==localRoot)workspaceWarning='上次工作目录暂时不可用，已打开应用内的默认工作目录；可重新选择工作目录。';root=localRoot;}
  try {if(root===localRoot)await fs.mkdir(root,{recursive:true});return await initializeWorkspace(root);}
  catch(error){
   if(root===localRoot)throw error;
   workspaceWarning='无法打开上次工作目录，已使用默认目录；请选择可读写的工作目录。';
   await fs.mkdir(localRoot,{recursive:true});return initializeWorkspace(localRoot);
  }
 })();
 try{return await initialization;}finally{initialization=undefined;}
}
async function selectWorkspace(root) {
 const previous=paths.workspace;
 try {
  const info=await initializeWorkspace(root);
  await atomicJSON(assertInside(path.join(paths.data,'workspace.json')),{root:info.root});
  workspaceWarning=undefined;delete info.warning;return info;
 } catch(error) {if(previous)await setWorkspaceRoot(previous);throw error;}
}
async function reloadWorkspace(){return getWorkspace();}
async function saveWorkflowPreset({name,settings,batch,id}) {
 const info=await getWorkspace();
 const safeName=String(name||'').trim();if(!safeName)throw new Error('请输入预设名称');
 const stem=safeName.normalize('NFKC').replace(/[^a-zA-Z0-9_-]+/g,'-').replace(/^[^a-zA-Z0-9]+/,'').slice(0,50)||'preset';
 if(id!==undefined&&(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(String(id))||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(String(id))))throw new Error('预设 ID 无效');
 const preset=normalizePreset({version:1,id:id||`${stem}-${randomUUID().slice(0,8)}`,name:safeName,settings,batch});
 if(info.presets.some(p=>p.id===preset.id))throw new Error('预设 ID 已存在，请另存为新预设');
 const file=assertInside(path.join(info.presetsDir,preset.id+'.json'),info.presetsDir);
 try{await atomicJSON(file,preset,{exclusive:true});}catch(error){if(error.code==='EEXIST')throw new Error('预设文件已存在，未覆盖原文件');throw error;}
 return workspaceInfo(info.root);
}
module.exports={VIDEO_EXTENSIONS,initializeWorkspace,getWorkspace,selectWorkspace,workspaceInfo,reloadWorkspace,scanInputs,saveWorkflowPreset};
