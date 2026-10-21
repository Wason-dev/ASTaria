import test from 'node:test'
import assert from 'node:assert/strict'
import { compareVersions, isCanonicalVersion, versionParts } from '../desktop/version.mjs'

test('展示标签 v1.0 解析为稳定版 1.0.0，包版本仍要求 canonical SemVer', () => {
  assert.deepEqual(versionParts('v1.0'), { core: [1n, 0n, 0n], pre: [], version: '1.0.0' })
  assert.equal(compareVersions('v1.0', '1.0.0'), 0)
  assert.equal(compareVersions('v1.0', '1.0.0-rc.1'), 1)
  assert.equal(compareVersions('v1.0', '1.0.1'), -1)
  for (const tag of ['v1.0', 'v1.0.0', 'v1.0.0-rc.1']) assert.equal(isCanonicalVersion(tag), false, tag)
  assert.equal(versionParts('1.0'), null, '无 v 前缀的两段包版本不能被自动补齐')
  assert.equal(versionParts('v1.0-rc.1'), null, '预发布标签必须包含完整三段版本')
})

test('canonical 校验支持稳定版、多段 beta 补丁、rc 和合法构建元数据', () => {
  for (const version of ['0.0.0', '0.1.0-beta.12.1', '1.0.0-beta.0', '1.0.0-rc.1', '1.0.0',
    '1.0.0+build.001', '1.0.0-rc.1+build.9', '1.0.0-alpha-1.0', '1.0.0-01a']) {
    assert.equal(isCanonicalVersion(version), true, version)
    assert.equal(versionParts(version).version, version)
  }
  assert.deepEqual(versionParts('v1.0.0-beta.12.1+build.9').pre, ['beta', '12', '1'])
  assert.equal(versionParts('v1.0.0-beta.12.1+build.9').version, '1.0.0-beta.12.1+build.9')
})

test('严格拒绝前导零、非法字段、非字符串、尾随换行和脚本注入', () => {
  const invalid = ['', '1.0', 'v1', '01.0.0', '1.01.0', '1.0.01', 'v01.0', 'v1.00', 'v01.0.0',
    '1.0.0.0', '1.0.0-01', '1.0.0-alpha.01', '1.0.0-beta.12.01', '1.0.0-rc.01',
    '1.0.0-', '1.0.0+', '1.0.0-alpha..1', '1.0.0+build..1', '1.0.0+build_1', '1.0.0-β',
    ' 1.0.0', '1.0.0 ', '1.0.0\n', '1.0.0\r\n', 'v1.0\n', '1.0.0\u2028', '1.0.0\0',
    "1.0.0'; Write-Output 'injected", '1.0.0$(whoami)', '1.0.0$INSTDIR', '1.0.0/../../other',
    1, null, undefined, {}, [], new String('1.0.0')]
  for (const value of invalid) {
    assert.equal(versionParts(value), null, String(value))
    assert.equal(isCanonicalVersion(value), false, String(value))
    assert.throws(() => compareVersions(value, '1.0.0'), /Invalid version/u, String(value))
    assert.throws(() => compareVersions('1.0.0', value), /Invalid version/u, String(value))
  }
})

test('版本长度上限仍为 120 字符', () => {
  const boundary = `1.0.0+${'a'.repeat(114)}`
  assert.equal(boundary.length, 120)
  assert.equal(isCanonicalVersion(boundary), true)
  assert.equal(versionParts(`${boundary}a`), null)
  assert.equal(isCanonicalVersion(`${boundary}a`), false)
  const display = `v${'9'.repeat(116)}.0`
  const parsed = versionParts(display)
  assert.equal(parsed.version.length, 120)
  assert.equal(isCanonicalVersion(parsed.version), true, '补齐后的版本必须仍能通过 canonical 校验')
  assert.equal(versionParts(`v${'9'.repeat(117)}.0`), null, '补齐后的版本也不能超过长度上限')
})

test('SemVer 预发布到稳定版按完整标识排序，beta 补丁低于下一 beta 和 rc', () => {
  const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta',
    '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-beta.12', '1.0.0-beta.12.1', '1.0.0-beta.13',
    '1.0.0-rc.1', '1.0.0-rc.2', '1.0.0-rc.10', '1.0.0']
  assert.deepEqual([...ordered].reverse().sort(compareVersions), ordered)
  for (let index = 1; index < ordered.length; index++) {
    assert.equal(compareVersions(ordered[index - 1], ordered[index]), -1)
    assert.equal(compareVersions(ordered[index], ordered[index - 1]), 1)
  }
})

test('核心版本与数字预发布标识都用 BigInt 精确排序', () => {
  for (const [older, newer] of [
    ['9007199254740992.0.0', '9007199254740993.0.0'],
    ['1.9007199254740992.0', '1.9007199254740993.0'],
    ['1.0.9007199254740992', '1.0.9007199254740993'],
    ['1.0.0-rc.9007199254740992', '1.0.0-rc.9007199254740993'],
  ]) {
    assert.equal(compareVersions(older, newer), -1)
    assert.equal(compareVersions(newer, older), 1)
  }
  assert.equal(compareVersions('1.0.0-1', '1.0.0-alpha'), -1)
})

test('构建元数据保留在 canonical 版本中但不影响优先级', () => {
  assert.equal(compareVersions('1.0.0+build.001', 'v1.0'), 0)
  assert.equal(compareVersions('1.0.0-rc.1+build.9', '1.0.0-rc.1+build.1'), 0)
  assert.equal(compareVersions('1.0.0-rc.1+build.99', '1.0.0-rc.2+build.1'), -1)
})
