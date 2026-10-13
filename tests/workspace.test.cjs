const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');
const {paths,setWorkspaceRoot}=require('../electron/paths.cjs');
const {initializeWorkspace,workspaceInfo,scanInputs,saveWorkflowPreset}=require('../electron/workspace.cjs');
const {builtinPreset}=require('../shared/workflow.cjs');

async function fixture(run){const root=await fs.mkdtemp(path.join(paths.temp,'workspace-test-'));const previous=paths.workspace;try{await initializeWorkspace(root);await run(root);}finally{if(previous)await setWorkspaceRoot(previous);assert(path.relative(paths.temp,root).startsWith('workspace-test-'));await fs.rm(root,{recursive:true,force:true});}}

test('workspace seeds folders once, reports malformed presets, and preserves existing files',async()=>fixture(async root=>{
 const info=await workspaceInfo(root);assert.equal(info.presets.length,1);assert.equal(info.presets[0].id,builtinPreset.id);
 for(const name of ['inputs','subtitles','presets','outputs','projects','.subtitle-foundry'])assert((await fs.stat(path.join(root,name))).isDirectory());
 const builtinFile=path.join(info.presetsDir,builtinPreset.id+'.json');const modified={...builtinPreset,name:'用户修改'};await fs.writeFile(builtinFile,JSON.stringify(modified));
 await fs.writeFile(path.join(info.presetsDir,'broken.json'),'{');await initializeWorkspace(root);
 const refreshed=await workspaceInfo(root);assert.equal(refreshed.presets[0].name,'用户修改');assert.equal(refreshed.presetErrors.length,1);
}));
test('input discovery filters files, is top-level by default, and skips junctions',async()=>fixture(async root=>{
 const input=path.join(root,'inputs');await fs.mkdir(path.join(input,'nested'));await fs.writeFile(path.join(input,'Film.MP4'),'a');await fs.writeFile(path.join(input,'notes.txt'),'b');await fs.writeFile(path.join(input,'nested','film.mkv'),'c');
 await fs.symlink(path.join(root,'outputs'),path.join(input,'linked'),process.platform==='win32'?'junction':'dir');await fs.writeFile(path.join(root,'outputs','excluded.mp4'),'d');
 assert.deepEqual((await scanInputs(root)).map(v=>v.name),['Film.MP4']);assert.equal((await scanInputs(root,true)).length,2);assert.equal((await workspaceInfo(root)).videos.length,2);
}));
test('saving custom preset sanitizes generated IDs, rejects traversal and never overwrites',async()=>fixture(async root=>{
 const saved=await saveWorkflowPreset({name:'我的 预设',settings:builtinPreset.settings});assert.equal(saved.presets.length,2);const custom=saved.presets.find(p=>p.id!==builtinPreset.id);assert.match(custom.id,/^preset-[a-f0-9]+$/);
 await assert.rejects(saveWorkflowPreset({name:'overwrite',id:custom.id,settings:builtinPreset.settings}),/存在/);
 await assert.rejects(saveWorkflowPreset({name:'escape',id:'../escape',settings:builtinPreset.settings}),/ID/);
 await assert.rejects(saveWorkflowPreset({name:'bad',settings:{asr:{threads:-1}}}));
 assert.equal((await workspaceInfo(root)).presets.length,2);assert(!(await fs.readdir(path.join(root,'presets'))).some(name=>name.endsWith('.tmp')));
}));
test('workspace rejects managed directory junction outside its root',async()=>{
 const root=await fs.mkdtemp(path.join(paths.temp,'workspace-test-'));const outside=await fs.mkdtemp(path.join(paths.temp,'workspace-test-'));const previous=paths.workspace;
 try{await fs.symlink(outside,path.join(root,'outputs'),process.platform==='win32'?'junction':'dir');await assert.rejects(initializeWorkspace(root));assert.equal(paths.workspace,previous);}
 finally{assert(path.relative(paths.temp,root).startsWith('workspace-test-'));assert(path.relative(paths.temp,outside).startsWith('workspace-test-'));await fs.rm(root,{recursive:true,force:true});await fs.rm(outside,{recursive:true,force:true});}
});
