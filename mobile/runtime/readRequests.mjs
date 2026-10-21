/** Share only concurrent identical reads. There is no settled-response cache:
 * writes fence both ends so an old in-flight read cannot serve a newer view. */
export function coalesceMobileReads(request) {
  const reads = new Map()
  let generation = 0
  return (path, input, options = {}) => {
    if (input !== undefined) {
      ++generation
      return Promise.resolve().then(() => request(path, input, options)).finally(() => { ++generation })
    }
    if (options.onEvent) return request(path, input, options)
    if (options.signal?.aborted) return Promise.reject(options.signal.reason ?? new DOMException('已取消', 'AbortError'))
    const key = JSON.stringify([generation, path, Object.entries(options.headers ?? {}).sort(([a], [b]) => a.localeCompare(b))])
    let entry = reads.get(key)
    if (!entry) {
      const controller = new AbortController()
      entry = { controller, users: 0, settled: false }
      reads.set(key, entry)
      entry.promise = Promise.resolve().then(() => request(path, undefined, { ...options, signal: controller.signal }))
        .finally(() => { entry.settled = true; if (reads.get(key) === entry) reads.delete(key) })
    }
    const current = entry
    current.users++
    return new Promise((resolve, reject) => {
      let done = false
      const finish = (callback, value) => {
        if (done) return
        done = true; options.signal?.removeEventListener('abort', cancel); current.users--
        if (!current.users && !current.settled) {
          reads.delete(key)
          current.controller.abort(new DOMException('已取消', 'AbortError'))
        }
        callback(value)
      }
      const cancel = () => finish(reject, options.signal.reason ?? new DOMException('已取消', 'AbortError'))
      options.signal?.addEventListener('abort', cancel, { once: true })
      current.promise.then(value => finish(resolve, value), error => finish(reject, error))
    })
  }
}
