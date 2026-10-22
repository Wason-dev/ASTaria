import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
const manifest = JSON.parse(await readFile('public/backgrounds/manifest.json'))
assert.equal(manifest.assets.length, 48)
const checks = []
for (const asset of manifest.assets) {
 const file = 'public/backgrounds/' + asset.file
 const bytes = await readFile(file)
 assert.equal(bytes.length, asset.bytes)
 assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256)
 const probe = spawnSync('ffmpeg', ['-hide_banner','-i',file], {encoding:'utf8'}).stderr
 assert.ok(probe.includes(`${asset.width}x${asset.height}`), asset.file + ' dimensions')
 let measuredMbps
 if(asset.kind==='video') {
  assert.match(probe,/Video: h264/);assert.match(probe,/yuv420p/);assert.match(probe,/30 fps/);assert.match(probe,/Duration: 00:00:07.00/)
  const rate = /Video:.*?(\d+) kb\/s/.exec(probe)
  assert.ok(rate, asset.file + ' bitrate'); measuredMbps=Number(rate[1])/1000
  assert.ok(measuredMbps >= asset.targetMbps*.9, asset.file + ' unexpectedly low bitrate')
  const decode=spawnSync('ffmpeg',['-v','error','-i',file,'-f','null','-'],{encoding:'utf8'})
  assert.equal(decode.status,0,decode.stderr)
 }
 checks.push({file:asset.file,width:asset.width,height:asset.height,measuredMbps,hashVerified:true})
}
const report = process.argv[2] ?? 'artifacts/background-media-2026-10-22/asset-verification.json'
await mkdir(dirname(report), { recursive: true })
await writeFile(report,JSON.stringify({checks,bytes:manifest.assets.reduce((sum,a)=>sum+a.bytes,0)},null,2)+'\n')
console.log(`Verified ${checks.length} assets: native dimensions, SHA256, H264/yuv420p/30FPS/7s, bitrate and full decode`)
