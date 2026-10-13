const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');
const {exportSubtitles,status,translate}=require('../electron/service.cjs');const {defaults}=require('../shared/defaults.cjs');const {parseSrt}=require('../electron/core/subtitles.cjs');const {paths,assertInside}=require('../electron/paths.cjs');
test('subtitle offset clips negative starts consistently and single-language export creates one SRT',async()=>{
 const dir=await fs.mkdtemp(path.join(paths.temp,'offset-test-'));
 try{const result=await exportSubtitles({cues:[{id:1,start:0,end:.3,text:'removed'},{id:2,start:.4,end:2,text:'保留'}],style:{...defaults.style,subtitleMode:'source',offset:-.5},mode:'source',name:'test'},dir);assert.equal(result.files.filter(f=>f.path.endsWith('.srt')).length,1);assert.deepEqual(parseSrt(await fs.readFile(path.join(dir,'source.srt'))).map(c=>[c.start,c.end,c.text]),[[0,1.5,'保留']]);assert.match(await fs.readFile(path.join(dir,'subtitles.ass'),'utf8'),/0:00:00\.00,0:00:01\.50/)}finally{assertInside(dir);await fs.rm(dir,{recursive:true,force:true})}
});
test('status only offers supported video encoders',async()=>{const result=await status();assert(result.encoders.includes('libx264'));assert(!result.encoders.includes('aac'));assert(!result.encoders.includes('srt'));assert(result.models.some(m=>m.installed))});
test('service resumes matching persisted translation without making API requests',async()=>{
 const cues=[{id:1,start:0,end:1,text:'Cache integration '+require('node:crypto').randomUUID()}],options={...defaults.translate,polish:false};
 const saved=cues.map(c=>({...c,translation:'缓存恢复'}));const hash=require('node:crypto').createHash('sha256').update(JSON.stringify({cues,options})).digest('hex');
 const cache=path.join(paths.workspaceData,'translation-cache',hash+'.json');await fs.mkdir(path.dirname(cache),{recursive:true});await fs.writeFile(cache,JSON.stringify({cues:saved}));let result;
 try{result=await translate(cues,options,{fetchImpl:async()=>{throw new Error('API must not be called for completed checkpoint')}});assert.deepEqual(result.cues,saved)}finally{assertInside(cache);await fs.rm(cache,{force:true});if(result){assertInside(result.folder);await fs.rm(result.folder,{recursive:true,force:true})}}
});
