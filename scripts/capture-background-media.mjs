import { createServer } from 'vite'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
const root=resolve(process.argv[2] ?? 'artifacts/background-media-2026-10-22')
const server=await createServer({configFile:false,root:process.cwd(),server:{host:'127.0.0.1',port:4202,strictPort:true},plugins:[{name:'local-master-capture',configureServer(vite){vite.middlewares.use((req,res,next)=>{
 const match=/^\/capture-frame\/(panorama|horizon)\/(landscape|portrait)-(dark|light)\/(\d{1,3})$/.exec(req.url)
 if(!match||req.method!=='POST')return next()
 void(async()=>{try{if(Number(match[4])>=240)throw Error('index');const parts=[];let length=0;for await(const part of req){length+=part.length;if(length>40*1024*1024)throw Error('large');parts.push(part)}const dir=resolve(root,match[1],match[2]+'-'+match[3]);await mkdir(dir,{recursive:true});await writeFile(resolve(dir,match[4].padStart(4,'0')+'.png'),Buffer.concat(parts));res.end('ok')}catch(error){res.statusCode=400;res.end(String(error))}})()
})}}]})
await server.listen();console.log('http://127.0.0.1:4202/scripts/background-media-capture.html')
