import {InputError} from './domain.js';
export interface Database {call<T>(name:string,input?:unknown):Promise<T>}
export class RESTStore implements Database{
 constructor(public url:string){}
 async call<T>(name:string,input:unknown={}):Promise<T>{
  let response:Response;try{response=await fetch(this.url.replace(/\/$/,'')+'/rpc/'+name,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(name==='apply_batch'?30000:10000)});}catch{throw new InputError('Database API unavailable or timed out.',503);}
  let value:unknown;try{value=await response.json();}catch{throw new InputError('Invalid database API response.',503);}
  if(!response.ok){const error=value as {code?:string;message?:string};if(error.code==='23505')throw new InputError('This supplier reference already belongs to different content or import settings. Use a new reference only for a genuinely new delivery.',409);if(error.code==='P0002')throw new InputError('Record not found.',404);if(error.code==='22023')throw new InputError(error.message??'Invalid import settings.');throw new InputError('Database transaction failed.',503);}
  return value as T;
 }
}
