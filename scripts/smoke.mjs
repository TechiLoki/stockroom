import{readFile}from'node:fs/promises';import{randomUUID}from'node:crypto';import assert from'node:assert/strict';
const base=(process.env.APP_URL||'http://localhost:8080').replace(/\/$/,'');const token=process.env.ADMIN_TOKEN||'stockroom-local-admin';
async function call(path,data,expected=200){const res=await fetch(base+path,{...(data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}),headers:{'Authorization':'Bearer '+token,...(data===undefined?{}:{'Content-Type':'application/json'})},signal:AbortSignal.timeout(10000)});const body=await res.json();assert.equal(res.status,expected,JSON.stringify(body));return body;}
async function upload(name,body){const res=await fetch(base+'/api/uploads?filename='+name,{method:'POST',headers:{Authorization:'Bearer '+token},body,signal:AbortSignal.timeout(10000)});assert.equal(res.status,201);return res.json();}
async function wait(id){for(let i=0;i<90;i++){const b=await call('/api/batches/'+id);if(b.status==='failed')throw Error(b.error);if(b.status==='completed')return b;await new Promise(r=>setTimeout(r,500));}throw Error('Import timed out');}
const source=await upload('supplier-demo.csv',await readFile(new URL('../fixtures/supplier-demo.csv',import.meta.url)));
const suffix=randomUUID().slice(0,8),supplier='Smoke Supplier '+suffix;
const config={supplier,reference:'SHIPMENT-1-'+suffix,mode:'add',currency:'USD',date:'2026-11-18',sheet:0,mapping:source.suggestions[0]};
const p=await call('/api/preview',{upload_id:source.id,config});assert.equal(p.stats.created,2);assert.equal(p.stats.invalid,5);
await call('/api/commit',{upload_id:source.id,config},422);
const first=await call('/api/commit',{upload_id:source.id,config,allow_partial:true},202);const done=await wait(first.id);assert.equal(done.stats.created,2);assert.equal(done.stats.invalid,5);
const replay=await call('/api/commit',{upload_id:source.id,config,allow_partial:true},202);assert.equal(replay.id,first.id);assert.equal(replay.duplicate,true);
const inventory=()=>call('/api/inventory?supplier='+encodeURIComponent(supplier));
assert.equal((await inventory()).items.find(p=>p.sku==='NOTE-01').quantity,12);
const second=await call('/api/commit',{upload_id:source.id,config:{...config,reference:'SHIPMENT-2-'+suffix},allow_partial:true},202);assert.equal((await wait(second.id)).stats.updated,2);
assert.equal((await inventory()).items.find(p=>p.sku==='NOTE-01').quantity,24);
await call('/api/commit',{upload_id:source.id,config:{...config,mode:'replace'},allow_partial:true},409);
const clean=await upload('older-snapshot.csv',Buffer.from('sku,name,quantity,price\nNOTE-01,Old notebook,1,1.00\nPEN-03,Old pens,1,1.00\n'));
const staleConfig={...config,reference:'OLDER-'+suffix,mode:'replace',date:'2026-11-17',mapping:clean.suggestions[0]};
const stale=await call('/api/commit',{upload_id:clean.id,config:staleConfig},202);assert.equal((await wait(stale.id)).stats.stale,2);assert.equal((await inventory()).items.find(p=>p.sku==='NOTE-01').quantity,24);
const report=await fetch(base+'/api/batches/'+first.id+'/errors',{headers:{Authorization:'Bearer '+token}}).then(r=>r.text());assert.ok(report.includes('occurs more than once'));assert.ok(report.includes("'=HYPERLINK"));
const workbook=await upload('supplier-demo.xlsx',await readFile(new URL('../fixtures/supplier-demo.xlsx',import.meta.url)));assert.equal(workbook.parsed.format,'xlsx');assert.ok(workbook.parsed.sheets[0].rows.at(-1).issues.length>0);
console.log(JSON.stringify({result:'PASS',supplier,first_batch:first.id,second_batch:second.id,stale_batch:stale.id,verified:['CSV/XLSX upload','explicit partial opt-in','duplicate prevention','add stock once per reference','reference conflict','stale snapshot guard','downloadable safe errors']},null,2));
