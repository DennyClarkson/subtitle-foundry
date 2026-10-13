'use strict';
// Assemble a genuine Electron Windows application. No script launcher or installer.
const fs=require('node:fs');const path=require('node:path');
const root=path.resolve(__dirname,'..');const source=path.join(root,'node_modules','electron','dist');
if(!fs.existsSync(path.join(source,'electron.exe')))throw new Error('Local Electron runtime missing');
if(!fs.existsSync(path.join(root,'dist','index.html')))throw new Error('Build the React UI first');
for(const entry of fs.readdirSync(source,{withFileTypes:true})){
 const name=entry.name==='electron.exe'?'字幕工坊.exe':entry.name==='LICENSE'?'ELECTRON-LICENSE.txt':entry.name;
 fs.cpSync(path.join(source,entry.name),path.join(root,name),{recursive:true});
}
const appDir=path.join(root,'resources','app');fs.mkdirSync(appDir,{recursive:true});
fs.writeFileSync(path.join(appDir,'package.json'),JSON.stringify({name:'subtitle-foundry-portable',productName:'字幕工坊',version:'1.0.0',main:'main.cjs'},null,2));
fs.writeFileSync(path.join(appDir,'main.cjs'),"'use strict';\nrequire('../../electron/main.cjs');\n");
console.log('Portable Electron application: '+path.join(root,'字幕工坊.exe'));
