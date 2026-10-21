import { spawnSync } from 'node:child_process';
const map = {darwin:['osx-arm64','mac','arm64','micromamba'], linux:['linux-64','linux','x64','micromamba'], win32:['win-64','win','x64','micromamba.exe']};
const [subdir,platform,arch,name] = map[process.platform];
if(process.arch!==arch) throw new Error('Unexpected runner architecture');
const run = args => {const r=spawnSync(process.execPath,args,{stdio:'inherit'});if(r.status!==0)process.exit(r.status??1)};
run(['scripts/fetch-micromamba.mjs',subdir,`resources/bin/${platform}/${arch}/${name}`]);
if(process.platform==='win32') {
 run(['scripts/fetch-micromamba.mjs',subdir,`resources/bin/${platform}/${arch}/micromamba-compat.exe`,'compatibility']);
 run(['packages/notebook-network-sandbox/vendor/windows/build.mjs','x64']);
}
const target=process.platform==='darwin'?['--mac','zip']:process.platform==='win32'?['--win','nsis']:['--linux','AppImage'];
run(['node_modules/electron-builder/cli.js',...target,'--publish','never','--config.directories.output=acceptance-package']);
