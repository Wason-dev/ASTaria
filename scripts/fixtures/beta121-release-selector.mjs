// Frozen selection logic from v0.1.0-beta.12.1 desktop/updates.mjs.
// Original full-file SHA-256: 6582c1d2e88c66394ed9f576f58ea51a97e531c0e190b22aa8716b6d2d4dd5e2
// No network, filesystem or signing operations. Do not change legacy behavior.
export const RELEASES_URL = 'https://github.com/Wason-dev/ASTaria/releases'
const RELEASE_API = 'https://api.github.com/repos/Wason-dev/ASTaria/releases?per_page=100'
const CHECK_INTERVAL = 6 * 60 * 60 * 1000
const MANUAL_INTERVAL = 60 * 1000

function versionParts(value) {
  if (typeof value !== 'string' || value.length > 120) return null
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/u.exec(value)
  if (!match) return null
  const pre = match[4]?.split('.') ?? []
  if (pre.some(part => /^\d+$/u.test(part) && part.length > 1 && part[0] === '0')) return null
  return { core: match.slice(1, 4).map(BigInt), pre, version: value.replace(/^v/u, '') }
}

/** SemVer ordering, including numeric prereleases; build metadata has no precedence. */
export function compareVersions(left, right) {
  const a = versionParts(left), b = versionParts(right)
  if (!a || !b) throw new Error('Invalid version')
  for (let index = 0; index < 3; index++) {
    if (a.core[index] !== b.core[index]) return a.core[index] > b.core[index] ? 1 : -1
  }
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index++) {
    if (a.pre[index] === undefined) return -1
    if (b.pre[index] === undefined) return 1
    const x = a.pre[index], y = b.pre[index]
    if (x === y) continue
    const xn = /^\d+$/u.test(x), yn = /^\d+$/u.test(y)
    if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1
    if (xn !== yn) return xn ? -1 : 1
    return x > y ? 1 : -1
  }
  return 0
}

function assetFor(release, name) {
  const expected = `${RELEASES_URL}/download/${encodeURIComponent(release.tag_name)}/${encodeURIComponent(name)}`
  return (Array.isArray(release.assets) ? release.assets : []).find(asset => asset && asset.name === name && asset.state === 'uploaded'
    && Number.isSafeInteger(asset.size) && asset.size > 0 && asset.browser_download_url === expected)
}

export function selectRelease(releases, current) {
  if (!Array.isArray(releases) || !versionParts(current.version)) throw new Error('Invalid release data')
  const beta = versionParts(current.version).pre.length > 0
  const candidates = releases.filter(release => release && !release.draft && versionParts(release.tag_name)
    && (beta || (!release.prerelease && !versionParts(release.tag_name).pre.length))
    && compareVersions(release.tag_name, current.version) >= 0)
    .sort((a, b) => compareVersions(b.tag_name, a.tag_name))
  const release = candidates[0]
  if (!release) return null
  const version = versionParts(release.tag_name).version
  const stem = current.platform === 'darwin' ? `ASTaria-${version}-mac-${current.arch}-adhoc` : `ASTaria-${version}-win-${current.arch}`
  const asset = current.platform === 'darwin' ? assetFor(release, `${stem}.dmg`)
    : current.platform === 'win32' && current.arch === 'x64' ? assetFor(release, `${stem}-setup.exe`) : null
  const manifest = asset ? assetFor(release, `${stem}.manifest.json`) : null
  return {
    version, tag: release.tag_name, prerelease: Boolean(release.prerelease || versionParts(version).pre.length),
    notes: typeof release.body === 'string' ? release.body.slice(0, 12000) : '',
    publishedAt: typeof release.published_at === 'string' ? release.published_at : null,
    releaseUrl: `${RELEASES_URL}/tag/${encodeURIComponent(release.tag_name)}`,
    downloadUrl: asset?.browser_download_url ?? null, assetName: asset?.name ?? null,
    size: asset?.size ?? null, manifestUrl: manifest?.browser_download_url ?? null,
  }
}
