const fs=require('node:fs/promises');
const path=require('node:path');
const {paths,assertInside}=require('./paths.cjs');
const DAY=24*60*60*1000;
let previewProtection=()=>[];
function setPreviewProtection(provider){previewProtection=provider;}
async function treeBytes(dir){let bytes=0;for(const entry of await fs.readdir(dir,{withFileTypes:true})){if(entry.isSymbolicLink())continue;const file=assertInside(path.join(dir,entry.name),dir);if(entry.isDirectory())bytes+=await treeBytes(file);else if(entry.isFile())bytes+=(await fs.stat(file)).size;}return bytes;}
// Only known application-managed cache locations are eligible. User inputs,
// subtitles, projects and finished video outputs never enter this function.
async function pruneCache(kind,{keep=[],maxCount,maxBytes,maxAgeMs}={}){
 const policies={
  previews:{base:path.join(paths.workspaceData,'previews'),dirs:true,maxCount:3,maxBytes:256*1024**2,maxAgeMs:7*DAY},
  translation:{base:path.join(paths.workspaceData,'translation-cache'),pattern:/^[a-f0-9]{64}\.json$/,maxCount:100,maxBytes:64*1024**2,maxAgeMs:30*DAY},
  batches:{base:path.join(paths.workspaceData,'batches'),pattern:/^[a-f0-9-]{36}\.json$/,maxCount:50,maxBytes:16*1024**2,maxAgeMs:30*DAY}
 };
 const policy=policies[kind];if(!policy)throw new Error('未知缓存类型');
 const base=assertInside(policy.base,paths.workspaceData);await fs.mkdir(base,{recursive:true});
 const protectedPaths=new Set(keep.map(file=>path.resolve(file)));const entries=[];
 for(const entry of await fs.readdir(base,{withFileTypes:true})){
  if(entry.isSymbolicLink()||(policy.dirs?!entry.isDirectory():!entry.isFile()||!policy.pattern.test(entry.name)))continue;
  const file=assertInside(path.join(base,entry.name),base);
  if(policy.dirs){try{await fs.access(path.join(file,'.preview-cache'));}catch{continue;}}
  if(kind==='previews'&&(previewProtection().some(active=>require('./paths.cjs').inside(active,file))||await liveOwner(path.join(file,'.encode-scratch'))))protectedPaths.add(file);
  const stat=await fs.stat(file);entries.push({file,mtime:stat.mtimeMs,bytes:policy.dirs?await treeBytes(file):stat.size});
 }
 entries.sort((a,b)=>b.mtime-a.mtime);let count=entries.length,bytes=entries.reduce((sum,entry)=>sum+entry.bytes,0),removed=0;
 for(const entry of [...entries].reverse()){
  if(protectedPaths.has(entry.file))continue;
  if(count<=(maxCount??policy.maxCount)&&bytes<=(maxBytes??policy.maxBytes)&&Date.now()-entry.mtime<=(maxAgeMs??policy.maxAgeMs))continue;
  // Refuse junction/path redirection again immediately before recursive removal.
  assertInside(entry.file,base);
  try{await fs.rm(entry.file,{recursive:!!policy.dirs,force:true,maxRetries:2,retryDelay:50});count--;bytes-=entry.bytes;removed++;}
  catch(error){if(!['EBUSY','EPERM','EACCES'].includes(error.code))throw error;}
 }
 return {count,bytes,removed};
}
async function removeScratch(dir,base){assertInside(dir,base);await fs.rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
async function markScratch(dir,name){const marker=assertInside(path.join(dir,name),dir);await fs.writeFile(marker,JSON.stringify({owner:'subtitle-foundry',pid:process.pid,createdAt:Date.now()}));return marker;}
async function deadOwner(marker){
 try{const data=JSON.parse(await fs.readFile(assertInside(marker),'utf8'));if(data.owner!=='subtitle-foundry'||!Number.isInteger(data.pid)||data.pid<=0)return false;try{process.kill(data.pid,0);return false}catch(error){return error.code==='ESRCH';}}
 catch{return false;}
}
async function liveOwner(marker){try{const data=JSON.parse(await fs.readFile(assertInside(marker),'utf8'));if(data.owner!=='subtitle-foundry'||!Number.isInteger(data.pid)||data.pid<=0)return false;try{process.kill(data.pid,0);return true}catch(error){return error.code!=='ESRCH';}}catch{return false;}}
async function recoverScratch(){
 const outputs=assertInside(paths.outputs,paths.workspace);await fs.mkdir(outputs,{recursive:true});
 for(const entry of await fs.readdir(outputs,{withFileTypes:true})){
  if(!entry.isDirectory()||entry.isSymbolicLink())continue;const dir=assertInside(path.join(outputs,entry.name),outputs);
  const work=path.join(dir,'.work');
  if(await deadOwner(path.join(work,'.subtitle-foundry-scratch')))await removeScratch(work,dir);
  for(const [marker,names]of [ ['.asr-scratch',['audio.wav']],['.encode-scratch',['subtitled.partial.mp4','subtitled.partial.mkv','subtitled.partial.webm','subtitled.partial.mov']] ]){
   const file=path.join(dir,marker);if(!await deadOwner(file))continue;
   for(const name of names)await fs.rm(assertInside(path.join(dir,name),dir),{force:true});await fs.rm(file,{force:true});
  }
 }
 const previewBase=assertInside(path.join(paths.workspaceData,'previews'),paths.workspaceData);await fs.mkdir(previewBase,{recursive:true});
 for(const entry of await fs.readdir(previewBase,{withFileTypes:true})){
  if(!entry.isDirectory()||entry.isSymbolicLink())continue;const dir=assertInside(path.join(previewBase,entry.name),previewBase);
  if(previewProtection().some(active=>require('./paths.cjs').inside(active,dir)))continue;
  if(await deadOwner(path.join(dir,'.encode-scratch'))){try{await fs.access(path.join(dir,'.preview-cache'));await removeScratch(dir,previewBase);}catch(error){if(error.code!=='ENOENT')throw error;}}
 }
 // Crash leftovers from atomic cache writes and model downloads are recognizable
 // by their UUID, and age-gated so another live operation is not disturbed.
 for(const [base,pattern]of [[paths.models,/^ggml-(base|large-v3-turbo-q5_0)\.[a-f0-9-]{36}\.part$/],[path.join(paths.workspaceData,'translation-cache'),/^[a-f0-9]{64}\.json\.[a-f0-9-]{36}\.tmp$/]]){
  assertInside(base);let entries;try{entries=await fs.readdir(base,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')continue;throw error;}
  for(const entry of entries){if(!entry.isFile()||!pattern.test(entry.name))continue;const file=assertInside(path.join(base,entry.name),base);if(Date.now()-(await fs.stat(file)).mtimeMs>2*DAY)await fs.rm(file,{force:true}).catch(error=>{if(!['EPERM','EBUSY','EACCES'].includes(error.code))throw error;});}
 }
}
async function maintainWorkspaceCaches(){const results=await Promise.allSettled([...['previews','translation','batches'].map(kind=>pruneCache(kind)),recoverScratch()]);return results.filter(result=>result.status==='rejected').map(result=>result.reason.message);}
module.exports={pruneCache,removeScratch,markScratch,recoverScratch,maintainWorkspaceCaches,setPreviewProtection};
