// Dense, resumable SQL copy of an already transformed PRIVATE image. This is
// not VACUUM of the product DB. Neither this tool nor its recovery touches the
// product garden.db. The old private image exits only after exact row proofs.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import{execFileSync}from'node:child_process';import{fileURLToPath}from'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),args=new Map(process.argv.slice(2).map(x=>{const[k,...v]=x.replace(/^--/,'').split('=');return[k,v.join('=')||true]}));
const out=path.resolve(root,String(args.get('out')||'.runtime/validation/r9-codex/image01'));
if(!out.startsWith(path.join(root,'.runtime')+path.sep))throw Error('Private pack evidence must stay in this worktree');
fs.mkdirSync(out,{recursive:true});
const source='files/data/garden-r9-stage.db',target='files/data/garden-r9-pack.db',old='files/data/garden-r9-unpacked.db',pkg='online.ainiannian.wujinxia';
const budget=Number(args.get('budget-ms')||480000),deadline=Date.now()+Math.max(10000,Math.min(480000,budget));
const sha=text=>crypto.createHash('sha256').update(text).digest('hex'),q=name=>'"'+name.replaceAll('"','""')+'"',lit=text=>"'"+String(text).replaceAll("'","''")+"'";
const txt=text=>"CAST(X'"+Buffer.from(text).toString('hex')+"' AS TEXT)",save=(name,value)=>fs.writeFileSync(path.join(out,name+'.json'),JSON.stringify(value,null,2));
const call=(a,binary=false,missing=false)=>{try{return execFileSync('C:/leidian/LDPlayer14/adb.exe',['-s','emulator-5556',...a],
 {encoding:binary?undefined:'utf8',stdio:['ignore','pipe','pipe'],windowsHide:true,maxBuffer:8*1024*1024,timeout:Math.max(1000,Math.min(60000,deadline-Date.now()))})}
 catch(e){if(missing&&e.status===1)return '';throw Object.assign(Error('Private pack device command failed'),{code:e.code||'PRIVATE_PACK_DEVICE_FAILED'})}};
const size=file=>Number(call(['shell','run-as',pkg,'stat','-c','%s',file],false,true).trim()||0);
function identity(file){if(!size(file))return null;const bytes=call(['exec-out','run-as',pkg,'head','-c','100',file],true);if(bytes.length!==100||bytes.subarray(0,16).toString('binary')!=='SQLite format 3\0')throw Error('Invalid private SQLite header');return{bytes:size(file),headerHex:bytes.toString('hex')}}
const same=(a,b)=>!!a&&!!b&&a.bytes===b.bytes&&a.headerHex===b.headerHex;
function sql(file,body,attach=false){const command=path.join(out,'pack-command.sql');fs.writeFileSync(command,'.bail on\n.timeout 5000\n.mode json\n.explain off\n'+
 (attach?`ATTACH DATABASE ${lit('file:'+source+'?mode=ro')} AS src;\n`:'')+'PRAGMA foreign_keys=OFF; PRAGMA synchronous=FULL;\n'+body+'\n');
 call(['push',command,'/data/local/tmp/r9-storage-pack.sql']);const seconds=Math.max(1,Math.min(50,Math.floor((deadline-Date.now())/1000)-5));
 const output=call(['shell',`run-as ${pkg} /system/bin/timeout -k 2 ${seconds} /data/local/tmp/r9-codex-sqlite ${lit(file)} < /data/local/tmp/r9-storage-pack.sql`]).trim();return output?JSON.parse(output):[];}
const read=body=>sql('file:'+source+'?mode=ro',body),write=body=>sql(target,body,true);
function seal(file){try{return JSON.parse(sql('file:'+file+'?mode=ro',"SELECT detail_json FROM backend_r9_pack_progress WHERE task='seal';")[0]?.detail_json||'null')}catch{return null}}
function publish(){const descriptor=JSON.parse(fs.readFileSync(path.join(out,'pack-switch.json'),'utf8'));
 const active=identity(source),proof=active&&seal(source);
 if(proof?.done&&proof.imageId===descriptor.imageId&&same(proof.input,descriptor.input)){
  const before=identity(old);if(before&&!same(before,descriptor.input))throw Error('Private old-image exit identity changed');
  if(before)call(['shell','run-as',pkg,'rm',old]);save('pack-result',{...descriptor,state:'published',oldPrivateImageRetired:true});return true;}
 if(active&&!same(active,descriptor.input))throw Error('Private pack source changed before publication');
 if(!same(identity(target),descriptor.output))throw Error('Verified packed file changed before publication');
 const packed=seal(target);if(!packed?.done||packed.imageId!==descriptor.imageId||!same(packed.input,descriptor.input))throw Error('Private packed file lacks its exact proof');
 if(active){if(size(old))throw Error('Private pack backup conflict');call(['shell','run-as',pkg,'mv',source,old]);}
 else if(!same(identity(old),descriptor.input))throw Error('Private original image backup differs');
 call(['shell','run-as',pkg,'mv',target,source]);return publish();}
let task='private-pack-preflight';
try{
 if(call(['shell','pidof',pkg+':engine'],false,true).trim()||call(['shell','pidof',pkg],false,true).trim())throw Error('App must stay closed while packing the private image');
 if(fs.existsSync(path.join(out,'pack-switch.json'))){publish();console.log(JSON.stringify({...JSON.parse(fs.readFileSync(path.join(out,'pack-result.json'))),state:'packed'}));process.exit(0);}
 if(args.has('recover')){console.log(JSON.stringify({state:'no-private-pack-publication'}));process.exit(0);}
 // Open RW once only to recover a killed PRIVATE incremental-vacuum journal.
 sql(source,'PRAGMA schema_version;');
 const input=identity(source),schema=read("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name;")
   .filter(row=>row.tbl_name!=='backend_r9_pack_progress'),tables=schema.filter(row=>row.type==='table');
 const image=JSON.parse(read("SELECT detail_json FROM backend_r9_image_progress WHERE task='manifest';")[0].detail_json);
 const metrics=read('SELECT (SELECT page_count FROM pragma_page_count) AS pages,(SELECT freelist_count FROM pragma_freelist_count) AS free,(SELECT page_size FROM pragma_page_size) AS page_size;')[0];
 const free=Number(call(['shell','run-as',pkg,'df','-k','files/data']).trim().split(/\r?\n/).at(-1).trim().split(/\s+/)[3])*1024;
 const required=Math.max(0,(metrics.pages-metrics.free)*metrics.page_size-size(target))*1.2+1024*1024*1024;
 if(!Number.isSafeInteger(free)||free<required)throw Error('Insufficient space for a verified dense private image');
 const schemaHash=sha(JSON.stringify(schema));let manifest,progress;
 const checkpoint=(name,cursor,done,detail={})=>{write(`INSERT INTO backend_r9_pack_progress VALUES(${lit(name)},${cursor},${Number(done)},${txt(JSON.stringify(detail))})
  ON CONFLICT(task) DO UPDATE SET last_rowid=excluded.last_rowid,done=excluded.done,detail_json=excluded.detail_json;`);progress?.set(name,{last_rowid:cursor,done:Number(done),detail_json:JSON.stringify(detail)});};
 const targetBytes=size(target),emptyInterrupted=targetBytes>0&&targetBytes<=65536&&
  write("SELECT count(*) AS n FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%';")[0].n===0;
 if(!targetBytes||emptyInterrupted){
  manifest={imageId:image.imageId,input,schemaHash,createdAt:new Date().toISOString()};
  write(`PRAGMA page_size=4096;PRAGMA auto_vacuum=INCREMENTAL;BEGIN;${tables.map(row=>row.sql+';').join('\n')}
   CREATE TABLE backend_r9_pack_progress(task TEXT PRIMARY KEY,last_rowid INTEGER NOT NULL,done INTEGER NOT NULL,detail_json TEXT NOT NULL);
   INSERT INTO backend_r9_pack_progress VALUES('manifest',0,1,${txt(JSON.stringify(manifest))});COMMIT;`);
 }
 progress=new Map(write('SELECT * FROM backend_r9_pack_progress;').map(row=>[row.task,row]));manifest=JSON.parse(progress.get('manifest')?.detail_json||'null');
 if(!manifest||!same(input,manifest.input)||manifest.schemaHash!==schemaHash||manifest.imageId!==image.imageId)throw Error('Private dense copy belongs to another frozen image; preserve it');
 const frozen=()=>{if(!same(identity(source),input))throw Error('Private pack source changed');};
 function verify(expected,actual,order){const statement=`SELECT * FROM _r9_pack_verify ORDER BY ${order}`;
  const proof=write(`CREATE TEMP TABLE _r9_pack_hash(a TEXT,b TEXT);CREATE TEMP VIEW _r9_pack_verify AS ${expected};
   INSERT INTO _r9_pack_hash(a) SELECT hex(sha3_query(${lit(statement)},256));DROP VIEW _r9_pack_verify;
   CREATE TEMP VIEW _r9_pack_verify AS ${actual};UPDATE _r9_pack_hash SET b=hex(sha3_query(${lit(statement)},256));SELECT * FROM _r9_pack_hash;`)[0];
  if(!proof||proof.a!==proof.b)throw Error('Private dense copy changed exact typed row values');return proof.a;}
 for(const table of tables){task='table:'+table.name;if(progress.get(task)?.done)continue;frozen();
  const columns=read(`PRAGMA table_xinfo(${q(table.name)});`).filter(col=>col.hidden===0).map(col=>col.name),list=columns.map(q).join(',');
  if(/WITHOUT\s+ROWID/i.test(table.sql)){
   const order=read(`PRAGMA table_info(${q(table.name)});`).filter(col=>col.pk>0).sort((a,b)=>a.pk-b.pk).map(col=>q(col.name)).join(',');
   write(`INSERT OR IGNORE INTO main.${q(table.name)}(${list}) SELECT ${list} FROM src.${q(table.name)};`);
   checkpoint(task,0,true,{hash:verify(`SELECT ${list} FROM src.${q(table.name)}`,`SELECT ${list} FROM main.${q(table.name)}`,order)});continue;
  }
  const bounds=read(`SELECT MIN(rowid) AS first,MAX(rowid) AS last,count(*) AS n FROM ${q(table.name)};`)[0];
  if(!bounds.n){checkpoint(task,0,true,{rows:0});continue;}
  let cursor=progress.get(task)?.last_rowid??bounds.first-1,detail=JSON.parse(progress.get(task)?.detail_json||'{"hash":""}');
  while(cursor<bounds.last&&Date.now()<deadline-5000){frozen();
   const end=read(`SELECT MAX(id) AS id FROM(SELECT rowid AS id FROM ${q(table.name)} WHERE rowid>${cursor} ORDER BY rowid LIMIT 8192);`)[0].id;
   if(!Number.isSafeInteger(end)||end<=cursor)throw Error('Private copy cursor did not advance');
   const range=`rowid>${cursor} AND rowid<=${end}`,expected=`SELECT rowid AS _r9_id,${list} FROM src.${q(table.name)} WHERE ${range}`;
   write(`BEGIN;INSERT OR IGNORE INTO main.${q(table.name)}(rowid,${list}) ${expected};COMMIT;`);
   detail.hash=sha(detail.hash+verify(expected,`SELECT rowid AS _r9_id,${list} FROM main.${q(table.name)} WHERE ${range}`,'_r9_id'));
   cursor=end;checkpoint(task,cursor,cursor===bounds.last,detail);save('pack-status',{state:'packing-private-image',task,cursor,maximum:bounds.last});
  }
  if(cursor<bounds.last){console.log(JSON.stringify({state:'checkpoint',task,productOriginalUntouched:true}));process.exit(0);}
  if(write(`SELECT count(*) AS n FROM main.${q(table.name)};`)[0].n!==bounds.n)throw Error('Private image row cardinality changed');
 }
 task='private-pack-ddl';
 if(!progress.get('sqlite-sequence')?.done){if(read("SELECT 1 AS found FROM sqlite_schema WHERE name='sqlite_sequence';").length)
  write('BEGIN;DELETE FROM sqlite_sequence;INSERT INTO sqlite_sequence(rowid,name,seq)SELECT rowid,name,seq FROM src.sqlite_sequence;COMMIT;');checkpoint('sqlite-sequence',0,true);}
 for(const item of schema.filter(row=>row.type!=='table')){task=item.type+':'+item.name;if(progress.get(task)?.done)continue;frozen();
  write(`BEGIN;${item.sql};INSERT INTO backend_r9_pack_progress VALUES(${lit(task)},0,1,'{}');COMMIT;`);
  if(Date.now()>=deadline-5000){console.log(JSON.stringify({state:'checkpoint',task,productOriginalUntouched:true}));process.exit(0);}
 }
 frozen();const proof={...manifest,done:true,verifiedAt:new Date().toISOString(),tables:tables.length,
  replacedPrivateBookkeeping:['backend_r9_pack_progress'],
  tableProofs:write("SELECT * FROM backend_r9_pack_progress WHERE task LIKE 'table:%' ORDER BY task;")};
 checkpoint('seal',0,true,proof);const output=identity(target);save('pack-switch',{imageId:image.imageId,input,output,proof:'exact SQL typed values/rowids and original schema',productOriginalUntouched:true});
 publish();console.log(JSON.stringify({...JSON.parse(fs.readFileSync(path.join(out,'pack-result.json'))),state:'packed'}));
}catch(error){save('pack-failure',{task,message:error.message,code:error.code||'PRIVATE_PACK_FAILED',productOriginalUntouched:true});
 if(Date.now()>=deadline-5000){console.log(JSON.stringify({state:'checkpoint',task,productOriginalUntouched:true}));process.exit(0);}
 console.log(JSON.stringify({state:'failed',task,message:error.message,productOriginalUntouched:true}));process.exitCode=2;}
