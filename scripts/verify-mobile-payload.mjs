/** Verify bytes before shipping a native candidate; never installs or runs it. */
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { resolve, join } from 'node:path'
const root=process.cwd(),out=process.env.MOBILE_PAYLOAD_REPORT
const args=process.argv.slice(2)
if(args.length && (args.length!==2 || args[0]!=='--apk'))throw Error('Usage: node scripts/verify-mobile-payload.mjs [--apk PATH]')
const apk=args[1]&&resolve(args[1]),digest=bytes=>createHash('sha256').update(bytes).digest('hex')
async function files(directory,prefix='') {
 const rows=[]
 for(const e of await readdir(join(directory,prefix),{withFileTypes:true})) {
  const path=prefix?`${prefix}/${e.name}`:e.name
  if(e.isSymbolicLink())throw Error(`Unexpected symlink ${path}`)
  if(e.isDirectory())rows.push(...await files(directory,path));else rows.push(path)
 }
 return rows.sort()
}
const dist=join(root,'dist-mobile'),expected=await files(dist),allowed=new Set(['capacitor.js','capacitor_plugins.js','cordova.js','cordova_plugins.js'])
const report={checkedAt:new Date().toISOString(),status:'passed',dist:'dist-mobile',files:[],platforms:[],apk:apk??null,failures:[]}
for(const name of expected)report.files.push({name,sha256:digest(await readFile(join(dist,name)))})
for(const [platform,directory] of [['android','mobile/android/app/src/main/assets/public'],['ios','mobile/ios/App/App/public']]) {
 const actual=await files(join(root,directory)),failures=[]
 for(const row of report.files) {
  if(!actual.includes(row.name))failures.push(`Missing ${row.name}`)
  else if(digest(await readFile(join(root,directory,row.name)))!==row.sha256)failures.push(`Changed ${row.name}`)
 }
 for(const name of actual)if(!expected.includes(name)&&!allowed.has(name))failures.push(`Stale asset ${name}`)
 report.platforms.push({platform,filesChecked:report.files.length,failures})
 report.failures.push(...failures.map(issue=>`${platform}: ${issue}`))
}
if(apk) {
 const names=execFileSync('/usr/bin/unzip',['-Z1',apk],{encoding:'utf8'}).split('\n').filter(Boolean)
 for(const row of report.files) {
  const name=`assets/public/${row.name}`
  if(!names.includes(name))report.failures.push(`APK missing ${name}`)
  else if(digest(execFileSync('/usr/bin/unzip',['-p',apk,name],{maxBuffer:Math.max(32*1024*1024,(await readFile(join(dist,row.name))).length+1)}))!==row.sha256)report.failures.push(`APK changed ${name}`)
 }
 for(const name of names.filter(name=>name.startsWith('assets/public/')&&!name.endsWith('/'))) {
  const asset=name.slice('assets/public/'.length)
  if(!expected.includes(asset)&&!allowed.has(asset))report.failures.push(`APK stale ${asset}`)
 }
 report.apkSha256=digest(await readFile(apk))
}
if(report.failures.length)report.status='failed'
if(out)await writeFile(resolve(out),JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify({status:report.status,files:report.files.length,platforms:report.platforms,apk:report.apk,apkSha256:report.apkSha256,failures:report.failures}))
if(report.failures.length)process.exitCode=1
