export const LIMITS={fileBytes:5*1024*1024,expandedBytes:20*1024*1024,rows:2000,columns:40,sheets:5,cell:1000};
export const currencies:Record<string,number>={USD:2,EUR:2,GBP:2,GEL:2,JPY:0,KWD:3};
export const fields=['sku','name','quantity','unit_price','currency','effective_date'] as const;
export type Field=typeof fields[number];
export type Mapping=Record<Field,number|null>;
export interface SourceRow {row_number:number;cells:string[];issues:string[]}
export interface Sheet {name:string;header_row:number;headers:string[];rows:SourceRow[]}
export interface ParsedFile {sheets:Sheet[];format:'csv'|'xlsx'}
export interface Config {supplier:string;reference:string;mode:'replace'|'add';currency:string;date:string;mapping:Mapping;sheet:number}
export interface Product {sku:string;name:string;quantity:number;unit_price_minor:number;currency:string;effective_date:string}
export interface RowError {field:string;code:string;message:string}
export interface ValidatedRow {row_number:number;original:string[];data:Product|null;errors:RowError[]}
export class InputError extends Error {constructor(message:string,public status=422){super(message);}}
export function isoDate(value:string):boolean{
 if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
 const d=new Date(value+'T00:00:00Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===value&&value>='1900-01-01'&&value<='2100-12-31';
}
export function decimalMinor(value:string,currency:string):number|null{
 const precision=Object.hasOwn(currencies,currency)?currencies[currency]:undefined;if(precision===undefined||!/^\d+(\.\d+)?$/.test(value))return null;
 const [whole='',fraction='']=value.split('.');if(fraction.length>precision)return null;
 const minor=BigInt(whole)*10n**BigInt(precision)+BigInt(fraction.padEnd(precision,'0')||'0');
 return minor<=1_000_000_000_000n?Number(minor):null;
}
export function validateConfig(value:unknown,sheet:Sheet):Config{
 if(!value||typeof value!=='object')throw new InputError('An import configuration is required.');
 const c=value as Config;
 if(typeof c.supplier!=='string'||!c.supplier.trim()||c.supplier.length>100)throw new InputError('Supplier must be 1–100 characters.');
 if(typeof c.reference!=='string'||!c.reference.trim()||c.reference.length>100)throw new InputError('Supplier reference must be 1–100 characters.');
 if(!['replace','add'].includes(c.mode))throw new InputError('Choose replace stock or add stock.');
 if(!Object.hasOwn(currencies,c.currency)||!isoDate(c.date))throw new InputError('Choose a supported currency and a valid ISO date.');
 if(!c.mapping||typeof c.mapping!=='object')throw new InputError('Column mapping is required.');
 const selected:number[]=[];
 for(const field of fields){const index=c.mapping[field];if(index===null&&(field==='currency'||field==='effective_date'))continue;if(!Number.isInteger(index)||index===null||index<0||index>=sheet.headers.length)throw new InputError('Map '+field.replaceAll('_',' ')+' to an available column.');selected.push(index);}
 if(new Set(selected).size!==selected.length)throw new InputError('Use a different source column for each mapped field.');
 return {supplier:c.supplier.trim().replace(/\s+/g,' '),reference:c.reference.trim().toUpperCase(),mode:c.mode,currency:c.currency,date:c.date,sheet:c.sheet,mapping:Object.fromEntries(fields.map(f=>[f,c.mapping[f]])) as Mapping};
}
export function validateRows(sheet:Sheet,c:Config):ValidatedRow[]{
 const rows=sheet.rows.map(row=>{
  const errors:RowError[]=row.issues.map(message=>({field:'row',code:'SOURCE_CELL',message}));
  const value=(field:Field)=>{const i=c.mapping[field];return i===null?'':(row.cells[i]??'').trim();};
  const error=(field:string,code:string,message:string)=>errors.push({field,code,message});
  const sku=value('sku').toUpperCase();const name=value('name').replace(/\s+/g,' ');
  if(!/^[A-Z0-9][A-Z0-9._/-]{0,63}$/.test(sku))error('sku','INVALID_SKU','SKU must start with a letter/number and contain at most 64 letters, numbers, dots, slashes, dashes or underscores.');
  if(!name||name.length>150||/^[=+@]/.test(name))error('name','INVALID_NAME','Use a product name of 1–150 characters without a formula prefix.');
  const quantityText=value('quantity');const quantity=/^\d+$/.test(quantityText)?Number(quantityText):NaN;
  if(!Number.isSafeInteger(quantity)||quantity<0||quantity>1_000_000)error('quantity','INVALID_QUANTITY','Quantity must be a whole number from 0 to 1,000,000.');
  const currency=(value('currency')||c.currency).toUpperCase();if(currencies[currency]===undefined)error('currency','INVALID_CURRENCY','Supported currencies: '+Object.keys(currencies).join(', ')+'.');
  const price=decimalMinor(value('unit_price'),currency);if(price===null)error('unit_price','INVALID_PRICE','Use a non-negative decimal price with the currency’s exact supported precision; omit currency symbols and grouping separators.');
  const date=value('effective_date')||c.date;if(!isoDate(date))error('effective_date','INVALID_DATE','Use a real date in YYYY-MM-DD format (1900–2100). Excel date serial numbers must be exported as ISO text.');
  const data={sku,name,quantity,unit_price_minor:price??0,currency,effective_date:date};
  return {row_number:row.row_number,original:row.cells,data:errors.length?null:data,errors};
 });
 const duplicates=new Map<string,ValidatedRow[]>();
 for(const row of rows){const i=c.mapping.sku;const sku=(i===null?'':row.original[i]??'').trim().toUpperCase();if(sku){const found=duplicates.get(sku)??[];found.push(row);duplicates.set(sku,found);}}
 for(const [sku,group] of duplicates){if(group.length>1)for(const row of group){row.errors.push({field:'sku',code:'DUPLICATE_SKU',message:`SKU ${sku} occurs more than once in this file. Correct all occurrences; none are selected automatically.`});row.data=null;}}
 return rows;
}
export function suggestedMapping(headers:string[]):Mapping{
 const aliases:Record<Field,string[]>={sku:['sku','productcode','itemcode','code'],name:['name','product','productname','item','description'],quantity:['quantity','qty','stock','onhand'],unit_price:['unitprice','price','cost','unitcost'],currency:['currency','ccy'],effective_date:['effectivedate','updatedat','date','asofdate']};
 const normalized=headers.map(h=>h.toLowerCase().replace(/[^a-z0-9]/g,''));const used=new Set<number>();
 return Object.fromEntries(fields.map(field=>{const i=normalized.findIndex((h,index)=>aliases[field].includes(h)&&!used.has(index));if(i>=0)used.add(i);return [field,i<0?null:i];})) as Mapping;
}
export function csvCell(value:unknown):string{
 let text=String(value??'');if(/^[\s\uFEFF]*[=+@-]/.test(text)||/^[\t\r]/.test(text))text="'"+text;
 return '"'+text.replaceAll('"','""')+'"';
}
export function errorCSV(rows:ValidatedRow[]):string{
 const output=[['source_row','sku','errors',...Array.from({length:Math.max(0,...rows.map(r=>r.original.length))},(_,i)=>'source_column_'+(i+1))]];
 for(const row of rows.filter(r=>r.errors.length))output.push([String(row.row_number),row.data?.sku??'',row.errors.map(e=>e.field+': '+e.message).join(' | '),...row.original]);
 return '\uFEFF'+output.map(line=>line.map(csvCell).join(',')).join('\r\n')+'\r\n';
}
