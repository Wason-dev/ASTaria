import type { GeodesicLut } from './geodesics'

let prepared: Promise<GeodesicLut> | undefined

/** One startup job shared by StrictMode/remounts, with no UI-thread RK4 loop. */
export function prepareSceneGeodesics(createWorker = () => new Worker(new URL('./geodesics.worker.ts', import.meta.url), { type: 'module', name: 'astaria-geodesics' })): Promise<GeodesicLut> {
  if (prepared) return prepared
  const job = new Promise<GeodesicLut>((resolve, reject) => {
    const worker = createWorker()
    const cleanup = () => { clearTimeout(timer); worker.terminate() }
    const fail = () => { cleanup(); reject(new Error('黑洞场景准备未完成，请重新打开 ASTaria')) }
    const timer = setTimeout(fail, 30_000)
    worker.onerror = fail
    worker.onmessageerror = fail
    worker.onmessage = event => {
      const table = event.data?.table as GeodesicLut | undefined
      if (!table || table.width !== 2048 || table.height !== 1536 || table.cameraRadius !== 30 || table.maxImpact !== 24
        || !(table.inverseRadius instanceof Float32Array) || table.inverseRadius.length !== 2048 * 1536
        || !(table.termination instanceof Float32Array) || table.termination.length !== 2048 * 4) { fail(); return }
      cleanup(); resolve(table)
    }
    worker.postMessage({ prepare: true })
  })
  prepared = job.catch(error => { prepared = undefined; throw error })
  return prepared
}

// Preserve the existing mobile entry and its tests while sharing the same
// preparation with Electron. There is one table/job per renderer process.
export const prepareMobileGeodesics = prepareSceneGeodesics
