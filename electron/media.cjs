const fs=require('node:fs');
const path=require('node:path');
const {Readable}=require('node:stream');
const {randomUUID}=require('node:crypto');

// The renderer explicitly releases replaced URLs. The hard ceiling also bounds
// registrations from abandoned dialogs, failed project restores, or IPC callers.
class MediaRegistry {
 constructor(limit=128){if(!Number.isSafeInteger(limit)||limit<1)throw new Error('播放地址数量上限必须为正整数');this.limit=limit;this.files=new Map();this.streams=new Map();this.disposed=false;}
 register(file){
  if(this.disposed)throw new Error('播放器已关闭');
  const key=randomUUID();this.files.set(key,path.resolve(file));
  while(this.files.size>this.limit)this.releaseKey(this.files.keys().next().value);
  return `media://local/${key}/${encodeURIComponent(path.basename(file))}`;
 }
 key(url){try{const parsed=new URL(url);return parsed.protocol==='media:'&&parsed.hostname==='local'?parsed.pathname.split('/')[1]:undefined}catch{return undefined}}
 releaseKey(key){const file=this.files.get(key);this.files.delete(key);for(const [stream,owner]of this.streams)if(owner===key)stream.destroy();return file;}
 release(url){return this.releaseKey(this.key(url));}
 stats(){return {registrations:this.files.size,streams:this.streams.size};}
 dispose(){this.disposed=true;for(const stream of this.streams.keys())stream.destroy();this.files.clear();}
 async response(request){
  const key=this.key(request.url),file=this.files.get(key);
  if(!file||this.disposed)return new Response('Not found',{status:404});
  try{
   const stat=await fs.promises.stat(file);if(!stat.isFile())return new Response('Not found',{status:404});
   if(request.signal?.aborted)return new Response(null,{status:499});
   // A release can occur while stat is pending.
   if(this.files.get(key)!==file)return new Response('Not found',{status:404});
   this.files.delete(key);this.files.set(key,file);
   const type={'.mp4':'video/mp4','.webm':'video/webm','.mov':'video/quicktime','.mp3':'audio/mpeg','.wav':'audio/wav','.png':'image/png','.jpg':'image/jpeg'}[path.extname(file).toLowerCase()]||'application/octet-stream';
   const headers={'Content-Type':type,'Accept-Ranges':'bytes','Cache-Control':'no-store'};
   let start=0,end=stat.size-1,status=200;
   const range=request.headers.get('range');
   const invalid=()=>new Response(null,{status:416,headers:{'Content-Range':`bytes */${stat.size}`}});
   if(range){
    const match=/^bytes=(\d*)-(\d*)$/.exec(range);if(!match||(!match[1]&&!match[2])||stat.size===0)return invalid();
    if(match[1]){start=Number(match[1]);if(match[2])end=Math.min(Number(match[2]),end);}
    else {const suffix=Number(match[2]);if(suffix<=0||!Number.isSafeInteger(suffix))return invalid();start=Math.max(0,stat.size-suffix);}
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=stat.size)return invalid();
    status=206;headers['Content-Range']=`bytes ${start}-${end}/${stat.size}`;
   }
   headers['Content-Length']=String(Math.max(0,end-start+1));
   if(!['GET','HEAD'].includes(request.method))return new Response(null,{status:405});
   if(request.method==='HEAD'||stat.size===0)return new Response(null,{status,headers});
   const stream=fs.createReadStream(file,{start,end,highWaterMark:64*1024});this.streams.set(stream,key);
   const abort=()=>stream.destroy();request.signal?.addEventListener('abort',abort,{once:true});
   stream.once('close',()=>{request.signal?.removeEventListener('abort',abort);this.streams.delete(stream);});
   if(request.signal?.aborted)stream.destroy();
   return new Response(Readable.toWeb(stream,{strategy:{highWaterMark:64*1024,size:chunk=>chunk.byteLength}}),{status,headers});
  }catch{return new Response('Media read failed',{status:500});}
 }
}
module.exports={MediaRegistry};
