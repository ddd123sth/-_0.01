// Atomic design-image replacement avoids transient Windows readers locking PNGs.
import {readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {resolve,dirname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=dirname(fileURLToPath(import.meta.url));
export async function exportScreenshot(locator,destination,options={}){
  const target=resolve(destination);
  if(!target.startsWith(root+sep)||!target.endsWith('.png'))throw new Error('Design export destination is outside the design directory');
  const temporary=`${target}.render-${process.pid}.tmp`;
  const bytes=await locator.screenshot(options);
  // Re-exporting unchanged artwork need not replace a file open in a preview.
  const existing=await readFile(target).catch(error=>{if(error.code!=='ENOENT')throw error;return null;});
  if(existing?.equals(bytes))return;
  await writeFile(temporary,bytes);
  try{
    for(let attempt=0;;attempt++){
      try{await rename(temporary,target);break;}
      catch(error){if(attempt>=9||!['EPERM','EACCES','EBUSY','UNKNOWN'].includes(error.code))throw error;await new Promise(done=>setTimeout(done,Math.min(200*(attempt+1),1000)));}
    }
  }finally{await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}
