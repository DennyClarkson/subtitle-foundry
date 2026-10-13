const {contextBridge,ipcRenderer}=require('electron');
const invoke=(channel)=>(...args)=>ipcRenderer.invoke('studio:'+channel,...args);
contextBridge.exposeInMainWorld('studio',{
 releaseMedia:invoke('releaseMedia'),
 ...Object.fromEntries(['getWorkspace','chooseWorkspace','reloadWorkspace','saveWorkflowPreset','startBatch','status','defaults','chooseVideo','sampleVideo','chooseSubtitles','chooseTranslation','probe','startTranscribe','startTranslate','exportSubtitles','startBurn','downloadModel','cancelJob','getJobs','saveProject','loadProject','loadLastProject','reveal','openOutput','mediaUrl','saveSettings','loadSettings'].map(name=>[name,invoke(name)])),
 onJob(callback){const handler=(_,job)=>callback(job);ipcRenderer.on('studio:job',handler);return ()=>ipcRenderer.removeListener('studio:job',handler)}
});
