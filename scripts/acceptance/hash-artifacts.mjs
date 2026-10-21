import {createHash} from 'node:crypto';
import {readFileSync,readdirSync,statSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
const files={};
function walk(root){if(!existsSync(root))return;for(const item of readdirSync(root,{withFileTypes:true})){const p=join(root,item.name);if(item.isDirectory())walk(p);else if(item.isFile())files[p]=createHash('sha256').update(readFileSync(p)).digest('hex')}}
for(const root of ['out/main','out/preload','out/renderer','out/backend'])walk(root);
writeFileSync('acceptance-results/build-artifacts.json',JSON.stringify({product:process.env.OPEN_SCIENCE_E2E_BUILD_ID,validation:process.env.GITHUB_SHA,files},null,2));
