// Package only the public, isolated prototype. No runtime, accounts or secrets.
import {copyFile, mkdir, readdir, readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname, join, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const repository=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const source=join(repository,'docs','design','20261020');
const output=join(repository,'.runtime','design-preview','public');
const rootFiles=[
  'index.html','share.css','prototype.html','prototype.css','prototype.js',
  'details.css','identity.css','identity.js','icons.js','settings-panels.js',
  'account-panels.js','interaction-gallery.html','gallery.css','gallery.js',
  'identity-board.css','identity-comparison.html','identity-comparison.png',
  ...['dawn','rain','moon'].flatMap(id=>[`identity-${id}.html`,`identity-${id}.png`]),
  ...[1,2].map(id=>`prototype-board-${id}.png`),
  ...[1,2,3,4].flatMap(id=>[`details-board-${id}.html`,`prototype-details-${id}.png`])
];
const assets=['logo-endless-summer.webp','garden-dawn.png','garden-rain.png','garden-moon.png','lucide-LICENSE.txt'];
const files=[...rootFiles,...assets.map(name=>`assets/${name}`)];
async function includePngDirectory(directory){
  const entries=await readdir(join(source,directory),{withFileTypes:true});
  for(const entry of entries){
    if(directory==='screens'&&entry.isDirectory()&&entry.name==='details')continue;
    if(!entry.isFile()||!entry.name.endsWith('.png'))throw new Error(`Unexpected file in public image directory: ${directory}/${entry.name}`);
    files.push(`${directory}/${entry.name}`);
  }
}
for(const id of ['dawn','rain','moon'])await includePngDirectory(`identities/${id}`);
await includePngDirectory('panels');
await includePngDirectory('screens');
await includePngDirectory('screens/details');

// Existing output must be a subset of this exact allowlist; never carry stale files.
const allowlist=new Set(files);
async function inspectExisting(directory,prefix=''){
  const entries=await readdir(directory,{withFileTypes:true}).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
  for(const entry of entries){
    const relative=prefix+entry.name;
    if(entry.isDirectory())await inspectExisting(join(directory,entry.name),relative+'/');
    else if(!entry.isFile()||!allowlist.has(relative))throw new Error(`Unexpected existing output: ${relative}`);
  }
}
await inspectExisting(output);
const manifest=[];
for(const relative of files){
  const from=resolve(source,relative);const to=resolve(output,relative);
  if(!from.startsWith(source+sep)||!to.startsWith(output+sep))throw new Error('Package path escaped design root');
  await mkdir(dirname(to),{recursive:true});await copyFile(from,to);
  const bytes=await readFile(to);manifest.push({path:relative,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
}
manifest.sort((a,b)=>a.path.localeCompare(b.path));
const directory=dirname(output);
await writeFile(join(directory,'manifest.json'),JSON.stringify({kind:'public-static-design-preview',generatedAt:new Date().toISOString(),files:manifest},null,2));
await writeFile(join(directory,'files.sha256'),manifest.map(file=>`${file.sha256}  ${file.path}`).join('\n')+'\n');
const release='20261020-'+createHash('sha256').update(JSON.stringify(manifest)).digest('hex').slice(0,12);
await writeFile(join(directory,'release.json'),JSON.stringify({release,fileCount:manifest.length,bytes:manifest.reduce((sum,file)=>sum+file.bytes,0)},null,2));
// Keep shell/config transport outside the public directory, normalized for Linux.
await mkdir(join(directory,'deploy'),{recursive:true});
for(const name of ['install-design-preview.sh','nginx-wujinxia-app-cloud.conf','nginx-wujinxia-app-design-preview.conf']){
  const content=(await readFile(join(repository,'deploy',name),'utf8')).replace(/^\uFEFF/,'').replace(/\r\n/g,'\n');
  await writeFile(join(directory,'deploy',name),content);
}
console.log(JSON.stringify({kind:'public-static-design-preview',output,release,fileCount:manifest.length,bytes:manifest.reduce((sum,file)=>sum+file.bytes,0)},null,2));
