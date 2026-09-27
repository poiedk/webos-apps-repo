const fs=require('fs'),path=require('path'),crypto=require('crypto');
const appDir=process.argv[2],ipk=process.argv[3],tag=process.argv[4];
if(!appDir||!ipk||!tag) throw new Error('usage: gen-manifest.js <appDir> <ipk> <tag>');
const info=JSON.parse(fs.readFileSync(path.join(appDir,'app','appinfo.json'),'utf8'));
const catalogIcon=fs.existsSync(path.join(appDir,'app','catalog-icon.svg'))?'catalog-icon.svg':(fs.existsSync(path.join(appDir,'app','catalog-icon.png'))?'catalog-icon.png':info.icon);
const manifest={
  id:info.id,version:info.version,type:info.type||'web',title:info.title,
  appDescription:info.appDescription||info.title,
  iconUri:'https://github.com/poiedk/webos-apps-repo/releases/download/'+tag+'/'+catalogIcon,
  sourceUrl:'https://github.com/poiedk/webos-apps-repo/tree/main/'+appDir,
  rootRequired:true,
  ipkUrl:'https://github.com/poiedk/webos-apps-repo/releases/download/'+tag+'/'+path.basename(ipk),
  ipkHash:{sha256:crypto.createHash('sha256').update(fs.readFileSync(ipk)).digest('hex')},
  ipkSize:fs.statSync(ipk).size
};
fs.mkdirSync('dist',{recursive:true});
fs.writeFileSync('dist/'+info.id+'.manifest.json',JSON.stringify(manifest,null,2)+'\n');
