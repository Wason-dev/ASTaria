import { cp, lstat, readFile, realpath } from 'node:fs/promises'
import { join, relative, isAbsolute, sep } from 'node:path'

/** Server runtime dependencies and their locked dependency closures. */
export async function copyServerDependencies(root, payload) {
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'))
  const modules = await realpath(join(root, 'node_modules')), copied = new Set()
  async function copy(name) {
    if (copied.has(name)) return
    if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/iu.test(name)) throw new Error('Invalid runtime dependency')
    const source = await realpath(join(modules, name)), rel = relative(modules, source)
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Dependency must resolve inside node_modules')
    const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
    if (pkg.version !== lock.packages[`node_modules/${name}`]?.version) throw new Error('Runtime dependency differs from package lock')
    copied.add(name)
    await cp(source, join(payload, 'node_modules', name), { recursive: true, dereference: false,
      filter: async path => {
        const info = await lstat(path)
        if (info.isSymbolicLink()) throw new Error('Runtime dependencies must not contain symbolic links')
        const parts = relative(source, path).split(sep)
        if (parts.some(part => part.startsWith('.') || ['node_modules', 'test', 'tests', '__fixtures__', '__snapshots__'].includes(part.toLowerCase()))) return false
        // Match test-file markers without pruning normal src/dist filenames.
        return !info.isFile() || !/\.(?:test|spec)\./iu.test(parts.at(-1))
      } })
    for (const dependency of Object.keys(pkg.dependencies ?? {})) await copy(dependency)
  }
  await copy('htmlparser2')
  await copy('@noble/hashes')
  return [...copied].sort()
}
