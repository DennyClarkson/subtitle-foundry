'use strict';
const {spawn}=require('node:child_process');
const {portableEnv,paths}=require('../paths.cjs');
const active=new Map();
function run(exe,args,{cwd=paths.root,signal,onOutput,timeout=0}={}) {
 return new Promise((resolve,reject)=>{
  if(signal?.aborted)return reject(new DOMException('任务已取消','AbortError'));
  const child=spawn(exe,args,{cwd,env:portableEnv(),windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  let stdout='',stderr='',timedOut=false,outputError,spawnError,stopping=false,forceTimer,timer;
  let markClosed;const closed=new Promise(resolve=>{markClosed=resolve});
  const terminate=()=>{
   if(stopping)return;stopping=true;
   if(process.platform==='win32'&&child.pid){
    // Terminate the process tree while the parent PID still identifies it.
    const killer=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,shell:false,stdio:'ignore'});
    killer.once('error',()=>child.kill('SIGKILL'));
    killer.once('close',code=>{if(code!==0&&active.has(child))child.kill('SIGKILL')});
   }else child.kill('SIGTERM');
   forceTimer=setTimeout(()=>{if(active.has(child))child.kill('SIGKILL')},1000);forceTimer.unref();
  };
  active.set(child,{terminate,closed});
  const abort=()=>terminate();signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted)abort();
  if(timeout)timer=setTimeout(()=>{timedOut=true;terminate()},timeout);
  const emit=(text,stream)=>{if(outputError||stopping)return;try{onOutput?.(text,stream)}catch(error){outputError=error;terminate()}};
  const readOut=data=>{const s=data.toString();stdout=(stdout+s).slice(-12_000_000);emit(s,'stdout')};
  const readErr=data=>{const s=data.toString();stderr=(stderr+s).slice(-50_000);emit(s,'stderr')};
  child.stdout.on('data',readOut);child.stderr.on('data',readErr);
  child.once('error',error=>{spawnError=error});
  child.once('close',code=>{
   clearTimeout(timer);clearTimeout(forceTimer);signal?.removeEventListener('abort',abort);
   child.stdout.removeListener('data',readOut);child.stderr.removeListener('data',readErr);active.delete(child);markClosed();
   if(signal?.aborted)reject(new DOMException('任务已取消','AbortError'));
   else if(outputError)reject(outputError);
   else if(spawnError)reject(spawnError);
   else if(timedOut)reject(new Error('外部程序执行超时'));
   else if(code!==0)reject(new Error(`${require('node:path').basename(exe)} 执行失败 (${code})\n${stderr.slice(-3500)}`));
   else resolve({stdout,stderr});
  });
 });
}
async function terminateAll(timeoutMs=5000){
 const children=[...active.values()];if(!children.length)return true;
 for(const child of children)child.terminate();
 let timer;try{return await Promise.race([Promise.all(children.map(child=>child.closed)).then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),timeoutMs)})])}finally{clearTimeout(timer)}
}
module.exports={run,terminateAll,activeProcessCount:()=>active.size};
