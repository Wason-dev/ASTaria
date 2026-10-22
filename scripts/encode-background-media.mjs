/** Reproducible local asset encoding. Input: 240 native 4K PNGs at 30 FPS for
 * each {landscape,portrait}-{dark,light}, authored by BlackHoleRenderer.
 * No downloaded footage, upscaling, audio, or network dependency. */
import { spawn } from 'node:child_process'
import { mkdir, stat, writeFile, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
const input = resolve(process.argv[2] ?? 'artifacts/background-media-2026-10-22')
const output = resolve(process.argv[3] ?? 'public/backgrounds')
await mkdir(output, { recursive: true })
const run = args => new Promise((accept, reject) => {
  const process = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] })
  let error = ''; process.stderr.on('data', data => { error += data })
  process.on('error', reject); process.on('exit', code => code === 0 ? accept() : reject(Error(error)))
})
const sizes = { '4k': [3840, 2160], '1080p': [1920, 1080], '720p': [1280, 720] }
const rates = { '4k': { high: 45, standard: 30 }, '1080p': { high: 20, standard: 12 }, '720p': { high: 10, standard: 6 } }
const manifest = { source: 'ASTaria BlackHoleRenderer native 4K / Ultra / Float32 LUT', fps: 30, duration: 7, loop: '1 second tail-to-head crossfade, first frame at source second 1', assets: [] }
for (const shape of ['landscape', 'portrait']) for (const theme of ['dark', 'light']) {
  const source = resolve(input, `${shape}-${theme}`)
  if (!(await stat(resolve(source, '0239.png'))).isFile()) throw Error('Incomplete native master')
  for (const [resolution, dimensions] of Object.entries(sizes)) for (const quality of ['high', 'standard']) {
    const [width, height] = shape === 'portrait' ? [...dimensions].reverse() : dimensions
    const basename = `${shape}-${theme}-${resolution}-${quality}`
    const image = resolve(output, basename + '.webp'), video = resolve(output, basename + '.mp4')
    await run(['-i', resolve(source, '0030.png'), '-vf', `scale=${width}:${height}:flags=lanczos`, '-frames:v', '1', '-c:v', 'libwebp', '-quality', quality === 'high' ? '96' : '90', '-compression_level', '6', image])
    const rate = rates[resolution][quality]
    // Source 1..8 followed by a crossfade from 7..8 to 0..1: wrapping at
    // output second 7 returns to source second 1 without a discontinuity.
    const filter = `[0:v]scale=${width}:${height}:flags=lanczos,format=yuv420p,split=2[body][head];[body]trim=start=1:end=8,setpts=PTS-STARTPTS[b];[head]trim=start=0:end=1,setpts=PTS-STARTPTS[h];[b][h]xfade=transition=fade:duration=1:offset=6,format=yuv420p[v]`
    await run(['-framerate', '30', '-i', resolve(source, '%04d.png'), '-filter_complex_threads', '2', '-filter_complex', filter, '-map', '[v]', '-t', '7', '-an', '-c:v', 'libx264', '-threads', '4', '-preset', 'fast', '-profile:v', 'high', '-level:v', resolution === '4k' ? '5.1' : '4.1', '-b:v', `${rate}M`, '-minrate', `${rate}M`, '-maxrate', `${rate}M`, '-bufsize', `${rate * 2}M`, '-x264-params', 'nal-hrd=cbr:force-cfr=1', '-pix_fmt', 'yuv420p', '-g', '60', '-movflags', '+faststart', video])
    for (const [path, kind] of [[image, 'image'], [video, 'video']]) {
      const bytes = await readFile(path)
      manifest.assets.push({ file: path.slice(output.length + 1), kind, width, height, quality, resolution, ...(kind === 'video' ? { targetMbps: rate } : { webpQuality: quality === 'high' ? 96 : 90 }), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
    }
    console.log(`Encoded ${basename} ${width}×${height} ${rate} Mbps`)
    await writeFile(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  }
}
