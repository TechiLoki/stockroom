import {readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
// Run each node:test module directly so environments that suppress isolated
// runner child output still execute and display every individual assertion.
const root=new URL('../',import.meta.url);
for(const file of readdirSync(new URL('tests/',root)).filter(f=>f.endsWith('.test.mjs')).sort()){
 const result=spawnSync(process.execPath,[new URL('tests/'+file,root).pathname],{stdio:'inherit'});
 if(result.error){console.error(result.error.message);process.exit(1);}
 if(result.status!==0)process.exit(result.status??1);
}
