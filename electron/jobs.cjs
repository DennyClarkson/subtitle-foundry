'use strict';
const fs=require('node:fs');const path=require('node:path');const {randomUUID}=require('node:crypto');const {paths}=require('./paths.cjs');
const MAX_JOBS=50;
function summary(result){if(!result)return undefined;const slim={};for(const key of ['folder','path','completed','failed','cancelled'])if(result[key]!==undefined)slim[key]=result[key];return slim}
class Jobs{
 constructor(publish,{maxJobs=MAX_JOBS,progressIntervalMs=100,historyIntervalMs=1000,onError=()=>{}}={}){
  this.jobs=new Map();this.publish=publish;this.controllers=new Map();this.pending=new Set();this.closed=false;
  this.maxJobs=Math.max(1,Math.floor(Number(maxJobs)||MAX_JOBS));this.progressIntervalMs=progressIntervalMs;this.historyIntervalMs=historyIntervalMs;this.lastHistory=0;this.lastPublish=new Map();this.onError=onError;
 }
 list(){return [...this.jobs.values()].reverse().map(job=>({...job,result:summary(job.result)}))}
 report(error){try{this.onError(error)}catch{}}
 trim(){for(const [id,job]of this.jobs){if(this.jobs.size<=this.maxJobs)break;if(job.status!=='running'){this.jobs.delete(id);this.lastPublish.delete(id)}}}
 flush(){this.lastHistory=Date.now();try{fs.writeFileSync(path.join(paths.workspaceData,'job-history.json'),JSON.stringify(this.list(),null,2))}catch(error){this.report(error)}}
 update(job,patch,{force=false}={}){
  Object.assign(job,patch);const now=Date.now();const terminal=job.status!=='running';
  if(force||terminal||now-(this.lastPublish.get(job.id)||0)>=this.progressIntervalMs){
   this.lastPublish.set(job.id,now);try{this.publish({...job,result:job.result?{...job.result}:undefined})}catch(error){this.report(error)}
  }
  // The completion event carries cues once. History/list retain only result locations and counts.
  if(terminal){job.result=summary(job.result);this.lastPublish.delete(job.id)}
  if(force||terminal||now-this.lastHistory>=this.historyIntervalMs)this.flush();
 }
 start(kind,task){
  if(this.closed)throw new Error('应用正在关闭，无法启动新任务');
  if(this.controllers.size)throw new Error('已有任务在运行，请等待完成或先取消。');
  const job={id:randomUUID(),kind,status:'running',stage:'starting',progress:0,message:'准备任务…',startedAt:new Date().toISOString()};
  const controller=new AbortController();this.controllers.set(job.id,controller);this.jobs.set(job.id,job);this.trim();this.update(job,{}, {force:true});
  const pending=Promise.resolve().then(()=>{controller.signal.throwIfAborted();return task({signal:controller.signal,onProgress:patch=>{if(job.status==='running'&&!controller.signal.aborted)this.update(job,patch)}})}).then(result=>{
   if(controller.signal.aborted){const error=new DOMException('任务已取消','AbortError');error.result=result;throw error;}
   this.update(job,{status:'completed',progress:100,stage:'done',message:kind==='batch'?`批处理结束：成功 ${result.completed}，失败 ${result.failed}，取消 ${result.cancelled}`:'已完成',result});
  }).catch(error=>{
   let message=String(error?.message||error);for(const [k,v]of Object.entries(process.env)){if(/deepseek|minimax/i.test(k)&&v)message=message.split(v).join('[REDACTED]')}
   const cancelled=controller.signal.aborted||error?.name==='AbortError';
   // Progress stops on abort, but the task's settled result contains the final
   // per-video cancellation state and cleanup warnings. Publish it once.
   const settled=error?.result;
   const batch=kind==='batch'&&Array.isArray(settled?.items)?{...job.batch,presetName:settled.presetName||job.batch?.presetName,items:structuredClone(settled.items),total:settled.items.length}:job.batch;
   this.update(job,{status:cancelled?'cancelled':'failed',stage:'done',message:cancelled?'已取消':message,error:message,...(settled?{result:settled}:{}),...(batch?{batch}:{})});
  }).finally(()=>{this.controllers.delete(job.id);this.pending.delete(pending)});
  this.pending.add(pending);return job.id;
 }
 cancel(id){this.controllers.get(id)?.abort()}
 cancelAll(){for(const c of this.controllers.values())c.abort()}
 async waitForIdle(timeoutMs=10000){
  if(!this.pending.size)return true;
  let timer;try{return await Promise.race([Promise.allSettled([...this.pending]).then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),timeoutMs)})])}finally{clearTimeout(timer)}
 }
 async dispose(timeoutMs=10000){this.closed=true;this.cancelAll();const idle=await this.waitForIdle(timeoutMs);this.flush();return idle}
}
module.exports={Jobs,MAX_JOBS};
