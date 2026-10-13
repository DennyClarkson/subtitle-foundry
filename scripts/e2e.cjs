'use strict';
// Genuine packaged UI smoke. Only ASR and translation are mocked in the labelled
// batch check; preview and batch video encoding run real FFmpeg.
const path=require('node:path'),fs=require('node:fs'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),temp=path.join(root,'data','temp');
fs.mkdirSync(temp,{recursive:true});process.env.TEMP=temp;process.env.TMP=temp;
const {_electron}=require('playwright-core');
const pass=name=>console.log('PASS',name);
const within=(file,base)=>{const relative=path.relative(base,path.resolve(file));return relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative));};
async function main(){
 const fixture=fs.mkdtempSync(path.join(temp,'packaged-ui-test-')),boot=path.join(fixture,'startup'),workspace=path.join(fixture,'chosen 工作目录');
 const config=path.join(root,'data','workspace.json'),original=fs.existsSync(config)?fs.readFileSync(config):null;
 let app,page,watchdog;const errors=[];
 try{
  fs.mkdirSync(boot);for(const name of ['inputs/nested','presets','subtitles'])fs.mkdirSync(path.join(workspace,name),{recursive:true});
  fs.writeFileSync(config,JSON.stringify({root:boot}));
  const video=path.join(workspace,'inputs','first.mp4');
  execFileSync(path.join(root,'tools','ffmpeg','ffmpeg.exe'),['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','testsrc2=size=640x360:rate=24','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','2','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac',video],{windowsHide:true,timeout:30000});
  fs.copyFileSync(video,path.join(workspace,'inputs','nested','second.mp4'));
  const source=path.join(workspace,'subtitles','source.srt'),translation=path.join(workspace,'subtitles','translation.srt');
  fs.writeFileSync(source,'1\n00:00:00,000 --> 00:00:01,500\nHello world.\n');fs.writeFileSync(translation,'1\n00:00:00,000 --> 00:00:01,500\n你好世界。\n');
  fs.writeFileSync(path.join(workspace,'presets','invalid.json'),'{ invalid fixture');
  const {builtinPreset}=require('../shared/workflow.cjs');
  const recursive={...structuredClone(builtinPreset),id:'ui-recursive',name:'UI recursive fixture',batch:{recursive:true,continueOnError:true}};
  fs.writeFileSync(path.join(workspace,'presets',recursive.id+'.json'),JSON.stringify(recursive));
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  app=await _electron.launch({executablePath:path.join(root,'字幕工坊.exe'),args:['--headless-test'],env,timeout:30000});
  watchdog=setTimeout(()=>{app.process().kill();process.exitCode=1;},240000);
  const runtime=await app.evaluate(({app})=>({packaged:app.isPackaged,path:app.getAppPath(),exe:process.execPath}));
  assert.equal(runtime.packaged,true);assert.equal(runtime.exe,path.join(root,'字幕工坊.exe'));assert.equal(runtime.path,path.join(root,'resources','app'));pass('genuine packaged executable');
  page=await app.firstWindow();page.setDefaultTimeout(12000);
  page.on('pageerror',error=>errors.push(error.message));page.on('console',msg=>{if(msg.type()==='error')errors.push(msg.text());});
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false));
  const wait=async(fn,arg,timeout=12000)=>page.waitForFunction(fn,arg,{polling:100,timeout});
  const pick=async file=>app.evaluate(({dialog},chosen)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[chosen]});},file);
  const tab=async name=>page.locator('.inspector-tabs').getByRole('button',{name,exact:true}).click();
  await wait(()=>document.querySelector('.statusbar')?.textContent.includes('FFmpeg 已就绪'));
  await page.evaluate(()=>{window.__jobEvents=[];window.__jobUnsubscribe=window.studio.onJob(job=>{const {result,...summary}=job;window.__jobEvents=[summary,...window.__jobEvents.filter(old=>old.id!==job.id)].slice(0,100);});});
  await page.getByRole('button',{name:'批量工作流',exact:true}).click();await pick(workspace);await page.getByRole('button',{name:'选择工作目录',exact:true}).click();
  await wait(root=>document.querySelector('.workspace-path')?.textContent.includes(root),workspace);
  assert.equal(JSON.parse(fs.readFileSync(config,'utf8')).root,workspace);for(const name of ['inputs','subtitles','presets','outputs','projects','.subtitle-foundry'])assert(fs.statSync(path.join(workspace,name)).isDirectory());pass('workspace chooser persists arbitrary folder and creates managed directories');
  await page.locator('.preset-errors summary').click();assert((await page.locator('.preset-errors').innerText()).includes('invalid.json'));pass('invalid preset visible; valid presets still usable');
  await page.getByLabel('工作流预设',{exact:true}).selectOption(recursive.id);await wait(()=>document.querySelectorAll('.batch-file').length===2);assert((await page.locator('.batch-file-list').innerText()).includes('nested'));pass('recursive preset lists nested input video');
  await page.getByRole('button',{name:'载入预设并调整设置',exact:true}).click();await tab('样式');
  assert.equal(await page.getByLabel('主字幕字号',{exact:true}).inputValue(),'36');assert.equal(await page.getByLabel('副字幕字号',{exact:true}).inputValue(),'48');assert.equal(await page.getByLabel('译文描边颜色',{exact:true}).inputValue(),'#2864b4');
  await page.getByLabel('主字幕字号',{exact:true}).fill('38');await page.getByRole('button',{name:'批量工作流',exact:true}).click();await page.locator('.save-workflow summary').click();await page.getByLabel('工作流预设名称',{exact:true}).fill('UI saved full preset');await page.getByRole('button',{name:'保存完整配置',exact:true}).click();
  await wait(()=>document.querySelector('[aria-label="工作流预设"]')?.selectedOptions?.[0]?.textContent==='UI saved full preset');
  const info=await page.evaluate(()=>window.studio.getWorkspace()),saved=info.presets.find(p=>p.name==='UI saved full preset');assert(saved);assert.equal(saved.settings.style.fontSize,38);assert.equal(saved.batch.recursive,true);for(const group of ['asr','translate','style','encode'])assert(Object.keys(saved.settings[group]).length>3);
  await page.getByRole('button',{name:'载入预设并调整设置',exact:true}).click();assert.equal(await page.getByLabel('主字幕字号',{exact:true}).inputValue(),'38');pass('load, modify, save and reload complete workflow preset');
  await pick(video);await page.getByRole('button',{name:'导入视频',exact:true}).click();await wait(()=>document.querySelector('video')?.readyState>=2);
  await pick(source);await page.getByRole('button',{name:'导入原文 SRT',exact:true}).click();await wait(()=>document.querySelectorAll('.cue-row').length===1);await tab('翻译');await pick(translation);await page.getByRole('button',{name:'导入已有译文 SRT',exact:true}).click();await wait(()=>document.querySelectorAll('.cue-row textarea')[1]?.value==='你好世界。');
  await tab('输出');await page.getByRole('button',{name:'导出 SRT + ASS',exact:true}).click();await wait(()=>document.querySelectorAll('.output-files>div').length===3);await page.getByRole('button',{name:'保存',exact:true}).click();await wait(()=>document.querySelector('[role="status"]')?.textContent.includes('项目已保存'));
  const recent=path.join(workspace,'.subtitle-foundry','last-project.json'),project=JSON.parse(fs.readFileSync(recent,'utf8'));assert.equal(project.workspaceRoot,workspace);assert.equal(project.settings.style.fontSize,38);assert.equal(project.lastExport.files.length,3);for(const file of project.lastExport.files){assert(within(file.path,path.join(workspace,'subtitles')));assert(fs.statSync(file.path).size>0);}assert(!fs.readFileSync(project.lastExport.files.find(f=>f.path.endsWith('source.srt')).path,'utf8').includes('Hello world.'));assert.equal(fs.readdirSync(path.join(workspace,'projects')).length,1);
  await page.getByLabel('字幕 1 原文',{exact:true}).fill('Changed locally');await pick(recent);await page.getByRole('button',{name:'打开项目',exact:true}).click();await wait(()=>document.querySelector('.cue-row textarea')?.value==='Hello world.');pass('single import, bilingual export and project save/restore use selected workspace');
  await page.getByRole('button',{name:'保存为默认设置',exact:true}).click();await wait(()=>document.querySelector('[role="status"]')?.textContent.includes('当前配置已设为默认设置'));assert.equal(JSON.parse(fs.readFileSync(path.join(workspace,'.subtitle-foundry','settings.json'),'utf8')).style.fontSize,38);pass('workspace default settings persistence');
  await page.getByRole('button',{name:'实际预览',exact:true}).click();await wait(()=>window.__jobEvents.some(job=>job.kind==='preview'&&job.status!=='running'),null,45000);
  const preview=(await page.evaluate(()=>window.studio.getJobs())).find(job=>job.kind==='preview');assert.equal(preview.status,'completed',preview.error);assert(within(preview.result.path,path.join(workspace,'.subtitle-foundry','previews')));assert(fs.statSync(preview.result.path).size>1000);await wait(()=>document.querySelector('.video-corner')?.textContent==='ENCODED'&&document.querySelector('video')?.readyState>=2);pass('real FFmpeg ASS preview produces playable encoded video');
  if(await page.getByRole('button',{name:'关闭任务记录',exact:true}).count())await page.getByRole('button',{name:'关闭任务记录',exact:true}).click();
  // Resource stress runs through the real packaged IPC/protocol/FFmpeg paths.
  // The observer keeps summaries only, so the test itself does not retain cue payloads.
  const resourceStats=()=>app.evaluate((_,root)=>process.getBuiltinModule('module').createRequire(root+'/package.json')(root+'/electron/main.cjs').getResourceStats(),root);
  const settleResources=async()=>{
   const deadline=Date.now()+12000;let stats;
   do{stats=await resourceStats();if(stats.controllers===0&&stats.pending===0&&stats.subprocesses===0&&stats.media.streams===0&&stats.inFlightIpc===0)return stats;await new Promise(resolve=>setTimeout(resolve,50));}while(Date.now()<deadline);
   assert.fail('Resources did not settle: '+JSON.stringify(stats));
  };
  const cdp=await page.context().newCDPSession(page);
  const memorySamples=[];
  const memorySample=async label=>{
   await cdp.send('HeapProfiler.collectGarbage');
   const {main,rendererProcessKiB}=await app.evaluate(async({app,BrowserWindow})=>{const forcedGc=typeof global.gc==='function';if(forcedGc)global.gc();const rendererPid=BrowserWindow.getAllWindows()[0].webContents.getOSProcessId();return {main:{forcedGc,heapUsed:process.memoryUsage().heapUsed,rss:process.memoryUsage().rss,external:process.memoryUsage().external,processKiB:await process.getProcessMemoryInfo()},rendererProcessKiB:app.getAppMetrics().find(metric=>metric.pid===rendererPid)?.memory};});
   const renderer=await cdp.send('Runtime.getHeapUsage');const resources=await settleResources();
   const sample={label,main,renderer:{forcedGc:true,usedSize:renderer.usedSize,totalSize:renderer.totalSize,processKiB:rendererProcessKiB},resources};memorySamples.push(sample);console.log('RESOURCE_SAMPLE '+JSON.stringify(sample));return sample;
  };
  const warm=await memorySample('after_first_preview_warmup');assert(warm.resources.media.registrations<=2);assert(warm.resources.jobs<=50);
  await page.evaluate(async video=>{
   for(let i=0;i<100;i++){
    const media=await window.studio.probe(video);
    try{const response=await fetch(media.url,{headers:{Range:'bytes=0-1023'}});if(response.status!==206||(await response.arrayBuffer()).byteLength!==1024)throw new Error('Media range read failed at iteration '+i);}
    finally{await window.studio.releaseMedia(media.url);}
   }
  },video);
  const afterImports=await memorySample('after_100_probe_read_release_cycles');assert.equal(afterImports.resources.media.registrations,warm.resources.media.registrations);assert.equal(afterImports.resources.jobs,warm.resources.jobs);pass('100 real probe/range-read/release cycles return registrations, streams and subprocesses to baseline');
  const previewBase=path.join(workspace,'.subtitle-foundry','previews');
  const bytesIn=directory=>fs.readdirSync(directory,{withFileTypes:true}).reduce((sum,entry)=>{assert(!entry.isSymbolicLink());const file=path.join(directory,entry.name);return sum+(entry.isDirectory()?bytesIn(file):fs.statSync(file).size);},0);
  const previewMeasurements=[];
  for(let i=1;i<=7;i++){
   const previousSrc=await page.locator('video').getAttribute('src');const known=await page.evaluate(()=>window.__jobEvents.map(job=>job.id));
   await page.getByRole('button',{name:'实际预览',exact:true}).click();
   await wait(known=>window.__jobEvents.some(job=>job.kind==='preview'&&job.status!=='running'&&!known.includes(job.id)),known,45000);
   const completed=(await page.evaluate(()=>window.studio.getJobs())).find(job=>job.kind==='preview');assert.equal(completed.status,'completed',completed.error);
   await wait(previous=>{const video=document.querySelector('video');return video?.getAttribute('src')!==previous&&video?.readyState>=2;},previousSrc);
   if(await page.getByRole('button',{name:'关闭任务记录',exact:true}).count())await page.getByRole('button',{name:'关闭任务记录',exact:true}).click();
   const stats=await settleResources();assert(stats.media.registrations<=2);assert(stats.jobs<=50);
   const directories=fs.readdirSync(previewBase,{withFileTypes:true}).filter(entry=>entry.isDirectory());const bytes=bytesIn(previewBase);
   // An active old preview and the new preview are protected during replacement.
   assert(directories.length<=4,'preview cache exceeded 3 retained + 1 protected directory');assert(bytes<=256*1024**2,'fixture preview cache exceeded byte budget');assert(fs.statSync(completed.result.path).size>1000);
   previewMeasurements.push({previews:i+1,count:directories.length,bytes,resources:stats});
   if(i===3||i===7)await memorySample('after_'+(i+1)+'_real_previews');
  }
  console.log('PREVIEW_CACHE_SAMPLES '+JSON.stringify(previewMeasurements));
  const first=memorySamples[0],last=memorySamples.at(-1);console.log('MEMORY_OBSERVATION '+JSON.stringify({mainHeapDelta:last.main.heapUsed-first.main.heapUsed,mainRssDelta:last.main.rss-first.main.rss,rendererHeapDelta:last.renderer.usedSize-first.renderer.usedSize,rendererWorkingSetDeltaKiB:typeof last.renderer.processKiB?.workingSetSize==='number'&&typeof first.renderer.processKiB?.workingSetSize==='number'?last.renderer.processKiB.workingSetSize-first.renderer.processKiB.workingSetSize:null,note:'Finite warm-run observation, not an absolute leak guarantee; Chromium/FFmpeg caches and allocator RSS may remain warm. Renderer GC forced; main GC availability reported per sample.'}));
  await cdp.detach();pass('8 real previews keep resources idle and preview cache bounded; main/renderer memory samples recorded');
  await app.evaluate(({app},root)=>{
   const service=process.getBuiltinModule('module').createRequire(root+'/package.json')(root+'/electron/service.cjs');
   service.transcribe=async(_media,_options,_folder,context)=>{context.onProgress?.({stage:'transcribe',progress:50,message:'MOCK ASR for UI test'});await new Promise(resolve=>setTimeout(resolve,250));return {cues:[{id:1,start:0,end:1.5,text:'Mock batch source.'}]};};
   service.translate=async(cues,_options,context)=>{context.onProgress?.({stage:'translate',progress:50,message:'MOCK translation for UI test'});return {cues:cues.map(cue=>({...cue,translation:'模拟批量字幕。'}))};};
  },root);
  await page.getByRole('button',{name:'批量工作流',exact:true}).click();await page.getByRole('button',{name:'运行全部 2 个视频',exact:true}).click();await wait(()=>window.__jobEvents.some(job=>job.kind==='batch'&&job.status!=='running'),null,45000);await wait(()=>document.querySelector('.batch-progress')?.textContent.includes('2 / 2 已完成'));
  const batch=(await page.evaluate(()=>window.studio.getJobs())).find(job=>job.kind==='batch');assert.equal(batch.status,'completed',batch.error);assert.equal(batch.result.completed,2);assert.equal(batch.result.failed,0);assert.equal(new Set(batch.batch.items.map(item=>item.folder)).size,2);for(const item of batch.batch.items){assert(within(item.folder,path.join(workspace,'outputs')));for(const name of ['source.srt','translation.srt','subtitles.ass','subtitled.mp4','workflow.json','project.json'])assert(fs.statSync(path.join(item.folder,name)).size>0);}pass('MOCK ASR/translation batch UI: real encodes, per-video status and isolated artifacts');
  assert.equal(await page.locator('.batch-state.completed').count(),2);
  await app.evaluate((_,root)=>{
   process.getBuiltinModule('module').createRequire(root+'/package.json')(root+'/electron/service.cjs').transcribe=async(_media,_options,_folder,context)=>new Promise((resolve,reject)=>{
    context.onProgress?.({stage:'transcribe',progress:5,message:'MOCK ASR waiting for UI cancellation'});
    const abort=()=>{const error=new Error('UI test cancelled');error.name='AbortError';reject(error);};
    if(context.signal.aborted)abort();else context.signal.addEventListener('abort',abort,{once:true});
   });
  },root);
  await page.getByRole('button',{name:'运行全部 2 个视频',exact:true}).click();await page.getByRole('button',{name:'取消批量任务',exact:true}).waitFor();await page.getByRole('button',{name:'取消批量任务',exact:true}).click();
  await wait(()=>window.__jobEvents.some(job=>job.kind==='batch'&&job.status==='cancelled'));
  const cancelled=(await page.evaluate(()=>window.studio.getJobs())).find(job=>job.kind==='batch');assert.equal(cancelled.status,'cancelled');assert(cancelled.batch.items.every(item=>item.status==='cancelled'));await wait(()=>document.querySelector('.batch-progress')?.textContent.includes('2 取消'));
  const manifests=path.join(workspace,'.subtitle-foundry','batches');assert(fs.readdirSync(manifests).some(file=>JSON.parse(fs.readFileSync(path.join(manifests,file),'utf8')).cancelled===2));pass('MOCK ASR batch cancellation preserves cancelled per-video UI and manifests');
  const finalResources=await settleResources();assert(finalResources.jobs<=50);assert(finalResources.media.registrations<=2);console.log('FINAL_RESOURCE_STATS '+JSON.stringify(finalResources));await page.evaluate(()=>window.__jobUnsubscribe?.());
  assert.deepEqual(errors,[]);pass('no renderer errors');
 }catch(error){if(page)console.error((await page.locator('body').innerText().catch(()=>'' )).slice(-4000));throw error;}
 finally{
  clearTimeout(watchdog);if(app)await app.close().catch(()=>{app.process().kill();});
  if(original!==null)fs.writeFileSync(config,original);else fs.rmSync(config,{force:true});
  const resolved=path.resolve(fixture);assert(within(resolved,temp)&&resolved!==path.resolve(temp)&&path.basename(resolved).startsWith('packaged-ui-test-'));fs.rmSync(resolved,{recursive:true,force:true});
 }
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
