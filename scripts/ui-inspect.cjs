const path=require('node:path');
const root=path.resolve(__dirname,'..');
process.env.TEMP=path.join(root,'data/temp');process.env.TMP=process.env.TEMP;
const {_electron}=require('playwright-core');
const env={...process.env,TEMP:path.join(root,'data/temp'),TMP:path.join(root,'data/temp')};
delete env.ELECTRON_RUN_AS_NODE;
(async()=>{
 const app=await _electron.launch({executablePath:path.join(root,'字幕工坊.exe'),args:['--headless-test'],env,timeout:30000});
 const watchdog=setTimeout(()=>{app.process().kill();process.exitCode=1;},25000);
 try{
  console.log('PACKAGED RUNTIME',await app.evaluate(({app})=>({isPackaged:app.isPackaged,appPath:app.getAppPath(),execPath:process.execPath,paths:Object.fromEntries(['appData','userData','sessionData','temp','logs','crashDumps'].map(name=>[name,app.getPath(name)]))})));
  const page=await app.firstWindow();
  page.on('console',msg=>console.log('CONSOLE',msg.type(),msg.text()));
  page.on('pageerror',error=>console.log('PAGEERROR',error.message));
  await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.webContents.setBackgroundThrottling(false);w.showInactive();});
  await page.waitForLoadState('domcontentloaded');
  console.log('INITIAL BODY',(await page.locator('body').innerText()).slice(-1000));
  console.log('STUDIO TYPE',await page.evaluate(()=>typeof window.studio));
  console.log('DEFAULTS',await page.evaluate(()=>window.studio.defaults()));
  console.log('STATUS',await page.evaluate(()=>window.studio.status()));
  await page.waitForFunction(()=>document.querySelector('.statusbar')?.textContent.includes('FFmpeg 已就绪'),null,{polling:100,timeout:10000});
  await page.screenshot({path:path.join(root,'outputs/ui-initial.png'),fullPage:true,timeout:10000});
  console.log('BODY',(await page.locator('body').innerText()).slice(0,7000));
 }finally{clearTimeout(watchdog);await app.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
