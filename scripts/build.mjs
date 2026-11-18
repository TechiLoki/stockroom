import {copyFileSync,mkdirSync}from'node:fs';
mkdirSync(new URL('../dist/web/',import.meta.url),{recursive:true});
for(const file of ['index.html','style.css'])copyFileSync(new URL('../web/'+file,import.meta.url),new URL('../dist/web/'+file,import.meta.url));
