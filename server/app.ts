import {createHmac,timingSafeEqual} from 'node:crypto';
import {basename} from 'node:path';
import {readFile} from 'node:fs/promises';
import {InputError,LIMITS,errorCSV,suggestedMapping,type ValidatedRow} from './domain.js';
import {parseFile} from './parser.js';
import {hash,preview,type Upload} from './service.js';
import type {Database} from './store.js';
export interface AppRequest{method:string;url:string;headers:Record<string,string|undefined>;body:Buffer}
export interface AppResponse{status:number;headers?:Record<string,string>;body:unknown}
interface Options{token:string;secureCookies?:boolean}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const equal=(a:string,b:string)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};
const session=(token:string,time:number)=>createHmac('sha256',token).update('stockroom:'+time).digest('hex');
const response=(body:unknown,status=200,headers?:Record<string,string>):AppResponse=>({status,body,headers});
const data=(request:AppRequest):Record<string,unknown>=>{if(request.body.length>65536)throw new InputError('JSON request exceeds 64 KiB.',413);try{const value=JSON.parse(request.body.toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();return value as Record<string,unknown>;}catch{throw new InputError('Expected a JSON object.',400);}};
function authorized(request:AppRequest,token:string):boolean{
 if(equal(request.headers.authorization??'','Bearer '+token))return true;
 const value=(request.headers.cookie??'').split(';').map(s=>s.trim()).find(s=>s.startsWith('stockroom_session='))?.slice('stockroom_session='.length);
 const match=/^(\d+)\.([0-9a-f]{64})$/.exec(value??'');if(!match)return false;const timestamp=Number(match[1]),now=Math.floor(Date.now()/1000);return timestamp>=now-43200&&timestamp<=now+30&&equal(match[2]!,session(token,timestamp));
}
export function createApp(db:Database,options:Options){
 return async(request:AppRequest):Promise<AppResponse>=>{
  try{
   const url=new URL(request.url,'http://localhost');const path=url.pathname,method=request.method;
   if(path==='/healthz')return response({ok:true});
   if(path==='/readyz'){await db.call('ping');return response({ready:true});}
   const origin=request.headers.origin,host=request.headers.host??'localhost';
   if(origin&&origin!=='http://'+host&&origin!=='https://'+host)throw new InputError('Cross-origin requests are not allowed.',403);
   if(path==='/api/login'&&method==='POST'){
    if(!equal(String(data(request).token??''),options.token))throw new InputError('Incorrect workspace token.',401);
    const time=Math.floor(Date.now()/1000);return response({ok:true},200,{'Set-Cookie':`stockroom_session=${time}.${session(options.token,time)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${options.secureCookies?'; Secure':''}`});
   }
   if(!authorized(request,options.token))throw new InputError('Sign in to your local workspace.',401);
   if(method!=='GET'&&!request.headers.authorization&&request.headers['x-stockroom-request']!=='1')throw new InputError('Missing request protection header.',403);
   if(path==='/api/logout'&&method==='POST')return response({ok:true},200,{'Set-Cookie':'stockroom_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'});
   if(path==='/api/overview'&&method==='GET')return response(await db.call('dashboard'));
   if(path==='/api/inventory'&&method==='GET')return response(await db.call('list_inventory',{p_search:url.searchParams.get('search')??'',p_supplier:url.searchParams.get('supplier')??'',p_offset:Number(url.searchParams.get('offset'))||0}));
   if(path==='/api/batches'&&method==='GET')return response(await db.call('list_batches'));
   if(path.startsWith('/api/samples/')&&method==='GET'){
    const file=path.slice('/api/samples/'.length);if(!['supplier-demo.csv','supplier-demo.xlsx'].includes(file))throw new InputError('Sample not found.',404);
    return response(await readFile(new URL('../../fixtures/'+file,import.meta.url)),200,{'Content-Type':file.endsWith('.csv')?'text/csv; charset=utf-8':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':'attachment; filename="'+file+'"'});
   }
   if(path==='/api/uploads'&&method==='POST'){
    const filename=basename(url.searchParams.get('filename')??'').replace(/[\x00-\x1f]/g,'').slice(0,200);if(!filename)throw new InputError('A filename is required.');
    const parsed=parseFile(request.body,filename);const upload=await db.call<Upload>('save_upload',{p_name:filename,p_hash:hash(request.body),p_parsed:parsed});
    return response({...upload,suggestions:upload.parsed.sheets.map(s=>suggestedMapping(s.headers))},201);
   }
   if((path==='/api/preview'||path==='/api/commit')&&method==='POST'){
    const input=data(request),id=String(input.upload_id??'');if(!uuid.test(id))throw new InputError('Invalid upload ID.',400);
    const result=await preview(db,id,input.config);
    if(path==='/api/preview')return response(result);
    // A completed additive shipment remains the same business event even when
    // current stock would make a new application invalid.
    const existing=await db.call<{id:string;status:string;fingerprint:string}|null>('find_batch',{p_supplier:result.config.supplier,p_reference:result.config.reference});
    if(existing){if(existing.fingerprint!==result.fingerprint)throw new InputError('This supplier reference already belongs to different content or import settings.',409);return response({id:existing.id,status:existing.status,duplicate:true},202);}
    const partial=input.allow_partial===true;
    if(result.stats.invalid!>0&&!partial)throw new InputError('Correct invalid rows or explicitly choose to import valid rows only.');
    if(result.rows.every(r=>!r.data))throw new InputError('There are no valid rows to import.');
    return response(await db.call('create_batch',{p_upload_id:id,p_config:result.config,p_rows:result.rows,p_fingerprint:result.fingerprint,p_allow_partial:partial}),202);
   }
   if(path==='/api/preview-errors'&&method==='POST'){
    const input=data(request),id=String(input.upload_id??'');if(!uuid.test(id))throw new InputError('Invalid upload ID.',400);
    const result=await preview(db,id,input.config);return response(errorCSV(result.rows),200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="validation-errors.csv"'});
   }
   const match=/^\/api\/batches\/([0-9a-f-]+)(?:\/(errors|retry))?$/i.exec(path);
   if(match&&uuid.test(match[1]!)){
    const id=match[1]!;
    if(method==='POST'&&match[2]==='retry')return response(await db.call('retry_batch',{p_id:id}),202);
    if(method==='GET'){
     const batch=await db.call<{rows:ValidatedRow[]}>('batch_details',{p_id:id});
     if(match[2]==='errors')return response(errorCSV(batch.rows),200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="import-errors-${id}.csv"`});
     if(!match[2])return response(batch);
    }
   }
   throw new InputError('Route not found.',404);
  }catch(error){if(error instanceof InputError)return response({error:error.message},error.status);console.error('Request failed:',error instanceof Error?error.name:'unknown');return response({error:'Unexpected processing error. No import has been confirmed.'},500);}
 };
}
