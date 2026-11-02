// Foreground-task batch driver, not a scheduled automation. Each child stops at
// a durable checkpoint; failures return control instead of repeating blindly.
import path from 'node:path';import {fileURLToPath} from 'node:url';import {spawn} from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const options=process.argv.slice(2);
if(options.some(arg=>!/^--out=.+/.test(arg)))throw new Error('Only an evidence output directory may be passed to the image driver');
let child=null,stopping=false;
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{stopping=true;child?.kill();});
let batch=0;
while(!stopping){
  batch++;let output='';
  const code=await new Promise((resolve,reject)=>{
    child=spawn(process.execPath,['tools/r9-storage-image.mjs','--build','--budget-ms=480000',...options],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',chunk=>{output+=chunk.toString();process.stdout.write(chunk);});
    child.stderr.on('data',()=>{}); // Child writes sanitized diagnostics to its own evidence file.
    child.once('error',reject);child.once('exit',resolve);
  });
  child=null;if(stopping)break;
  if(code!==0){process.exitCode=code||2;break;}
  let result;try{result=JSON.parse(output.trim().split(/\r?\n/).at(-1));}catch{throw new Error('Migration batch returned no structured outcome');}
  if(result.state==='verified-stage'){console.log(JSON.stringify({state:'stage-ready',batches:batch,activationRequested:false}));break;}
  if(result.state!=='checkpoint')throw new Error('Migration batch did not reach a safe checkpoint');
}
