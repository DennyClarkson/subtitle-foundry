const fs=require('node:fs');const fsp=fs.promises;const path=require('node:path');const crypto=require('node:crypto');
const {paths}=require('../paths.cjs');
const models=[
 {id:'base',label:'Base · 快速校验 / 轻量 CPU',size:'148 MB',bytes:147951465,sha256:'60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe'},
 {id:'large-v3-turbo-q5_0',label:'Large v3 Turbo Q5 · 推荐中英混合',size:'574 MB',bytes:574041195,sha256:'394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2'},
];
function modelPath(id){if(!models.some(m=>m.id===id)) throw new Error('未知转写模型');return path.join(paths.models,`ggml-${id}.bin`)}
function listModels(){return models.map(m=>({...m,installed:fs.existsSync(modelPath(m.id))&&fs.statSync(modelPath(m.id)).size===m.bytes}))}
async function downloadModel(id,{signal,onProgress}={}){
 const model=models.find(m=>m.id===id);if(!model)throw new Error('未知模型');
 if(listModels().find(m=>m.id===id).installed)return {path:modelPath(id)};
 const dest=modelPath(id),partial=dest+'.'+crypto.randomUUID()+'.part';
 let res,file,committed=false;
 try{
  signal?.throwIfAborted();
  res=await fetch(`https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${id}.bin`,{signal});
  signal?.throwIfAborted();
  if(!res.ok)throw new Error(`模型下载失败 HTTP ${res.status}`);
  if(!res.body)throw new Error('模型下载响应为空');
  file=await fsp.open(partial,'wx');const hash=crypto.createHash('sha256');let bytes=0;
  for await(const value of res.body){
   signal?.throwIfAborted();
   if(bytes+value.length>model.bytes)throw new Error('模型下载大小超过预期');
   let offset=0;while(offset<value.length){const {bytesWritten}=await file.write(value,offset,value.length-offset);if(!bytesWritten)throw new Error('无法写入模型文件');offset+=bytesWritten}
   hash.update(value);bytes+=value.length;
   onProgress?.({stage:'download',progress:Math.min(99,bytes/model.bytes*100),message:`下载 ${model.label} · ${Math.round(bytes/1e6)} / ${Math.round(model.bytes/1e6)} MB`});
  }
  await file.close();file=null;signal?.throwIfAborted();
  if(bytes!==model.bytes||hash.digest('hex')!==model.sha256)throw new Error('模型 SHA256 校验失败，请重新下载');
  await fsp.rename(partial,dest);committed=true;return {path:dest};
 }finally{
  try{if(file)await file.close()}finally{
   try{if(res?.body&&!res.body.locked)await res.body.cancel?.()}catch{}
   if(!committed)await fsp.rm(partial,{force:true});
  }
 }
}
module.exports={listModels,downloadModel,modelPath};
