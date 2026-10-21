/// <reference lib="webworker" />
import { createGeodesicLut } from './geodesics'

// Keep the exact desktop integration and sample grid. Only its execution
// thread changes; transfer the completed buffers instead of cloning 12 MiB.
self.onmessage = () => {
  try {
    const table = createGeodesicLut({ cameraRadius: 30, maxImpact: 24, width: 2048, height: 1536 })
    self.postMessage({ table }, { transfer: [table.inverseRadius.buffer, table.termination.buffer] })
  } catch { self.postMessage({ error: '黑洞场景准备未完成，请重新打开 ASTaria' }) }
}
