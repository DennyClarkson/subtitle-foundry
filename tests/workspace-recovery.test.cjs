const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {paths}=require('../electron/paths.cjs');
const {getWorkspace}=require('../electron/workspace.cjs');
test('unavailable remembered workspace opens a usable local fallback without recreating the missing folder',async()=>{
 const saved={...paths},root=await fs.mkdtemp(path.join(paths.temp,'recovery-test-'));
 try{
  Object.assign(paths,{root,data:path.join(root,'data'),workspace:path.join(root,'workspace'),outputs:path.join(root,'workspace','outputs'),workspaceData:path.join(root,'workspace','.subtitle-foundry')});
  await fs.mkdir(paths.data);const missing=path.join(root,'disconnected-drive');
  await fs.writeFile(path.join(paths.data,'workspace.json'),JSON.stringify({root:missing}));
  const info=await getWorkspace();assert.equal(info.root,path.join(root,'workspace'));assert.match(info.warning,/暂时不可用/);assert.equal(info.presets.length,1);
  await assert.rejects(fs.stat(missing),{code:'ENOENT'});
  assert.equal(JSON.parse(await fs.readFile(path.join(paths.data,'workspace.json'),'utf8')).root,missing);
 }finally{Object.assign(paths,saved);assert(path.resolve(root).startsWith(path.resolve(saved.temp)+path.sep));await fs.rm(root,{recursive:true,force:true});}
});
