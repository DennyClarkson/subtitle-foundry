const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const paths = {
 root, data:path.join(root,'data'), workspace:path.join(root,'workspace'), outputs:path.join(root,'workspace','outputs'), workspaceData:path.join(root,'workspace','.subtitle-foundry'), temp:path.join(root,'data','temp'),
 ffmpeg:path.join(root,'tools','ffmpeg','ffmpeg.exe'), ffprobe:path.join(root,'tools','ffmpeg','ffprobe.exe'),
 whisper:path.join(root,'tools','whisper','Release','whisper-cli.exe'), models:path.join(root,'tools','models'),
};
function inside(file, base=root) { const rel=path.relative(base,path.resolve(file)); return rel===''||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel)); }
function existingAncestor(file){let ancestor=path.resolve(file);while(!fs.existsSync(ancestor)){const parent=path.dirname(ancestor);if(parent===ancestor)break;ancestor=parent}return ancestor;}
function verifyBoundary(file,base){
 if(!inside(file,base))throw new Error('路径必须位于当前工作文件夹或便携应用文件夹中');
 const ancestor=existingAncestor(file),baseAncestor=existingAncestor(base);
 const realBase=path.resolve(fs.realpathSync(baseAncestor),path.relative(baseAncestor,base));
 const realTarget=path.resolve(fs.realpathSync(ancestor),path.relative(ancestor,file));
 if(!inside(realTarget,realBase))throw new Error('路径的符号链接或目录联接指向了授权文件夹外部');
}
function assertInside(file,base) {
 file=path.resolve(file);
 const allowed=[paths.workspace,root].filter(boundary=>inside(file,boundary));
 if(!allowed.length)throw new Error('路径必须位于当前工作文件夹或便携应用文件夹中');
 let valid=false;for(const boundary of allowed){try{verifyBoundary(file,boundary);valid=true;break}catch{}}
 if(!valid)throw new Error('路径的符号链接或目录联接指向了授权文件夹外部');
 if(base)verifyBoundary(file,path.resolve(base));
 return file;
}
function setWorkspaceRoot(directory){
 const resolved=path.resolve(directory);
 if(!fs.statSync(resolved).isDirectory())throw new Error('请选择一个工作文件夹');
 paths.workspace=fs.realpathSync(resolved);paths.outputs=path.join(paths.workspace,'outputs');paths.workspaceData=path.join(paths.workspace,'.subtitle-foundry');
 return paths.workspace;
}
for(const dir of [paths.data,paths.temp,paths.models,paths.workspace,paths.outputs,paths.workspaceData]) {assertInside(dir);fs.mkdirSync(dir,{recursive:true});}
function folder(name='job',base=paths.outputs) { const safe=String(name).normalize('NFKC').replace(/[^\p{L}\p{N}_-]+/gu,'-').slice(0,55)||'job'; const dir=assertInside(path.join(base,`${safe}-${new Date().toISOString().replace(/[:.]/g,'-')}-${require('node:crypto').randomBytes(3).toString('hex')}`),base);fs.mkdirSync(dir,{recursive:true});return dir; }
function portableEnv() { const env={...process.env,TEMP:paths.temp,TMP:paths.temp,CUDA_CACHE_PATH:path.join(paths.data,'cuda-cache'),HF_HOME:path.join(paths.data,'huggingface')};for(const key of Object.keys(env))if(/^(deepseek|minimax)$/i.test(key))delete env[key];return env; }
module.exports={paths,inside,assertInside,folder,portableEnv,setWorkspaceRoot};
